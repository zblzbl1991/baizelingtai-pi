import http from "node:http";
import https from "node:https";
import type { WeKnoraSettings } from "./weknora-config.js";

export type RecordData = Record<string, unknown>;

export class WeKnoraError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export function record(value: unknown): RecordData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WeKnoraError("INVALID_RESPONSE", "WeKnora 返回的数据结构不符合 0.7.0 接口");
  }
  return value as RecordData;
}

export function identifier(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(value)) {
    throw new WeKnoraError("INVALID_ID", "请传入列表或检索结果中的 ID，不支持名称或路径");
  }
  return value;
}

export class WeKnoraClient {
  constructor(public readonly settings: WeKnoraSettings) {}

  request(method: "GET" | "POST", endpoint: string, body?: RecordData): Promise<RecordData> {
    const { baseUrl, apiKey, timeoutMs, maxResponseBytes } = this.settings;
    if (!baseUrl || !apiKey) {
      throw new WeKnoraError("CONFIG_ERROR", "请配置 WEKNORA_BASE_URL 和 WEKNORA_API_KEY");
    }
    const url = new URL(baseUrl + endpoint);
    const payload = body ? JSON.stringify(body) : undefined;
    // Native HTTP deliberately avoids workstation proxy environment variables.
    const send = url.protocol === "https:" ? https.request : http.request;
    return new Promise((resolve, reject) => {
      const request = send(url, {
        method, signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "X-API-Key": apiKey, Accept: "application/json", "Accept-Encoding": "identity",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      }, async (response) => {
        try {
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            const hint = status === 401 ? "API Key 无效或已过期"
              : status === 403 ? "Key 缺少 retrieve 权限或知识库不在授权范围"
              : status === 404 ? "请检查 API 地址（含 /api/v1）及版本对应的接口"
              : status >= 300 && status < 400 ? "接口返回重定向；请配置最终 API 地址"
              : "WeKnora 请求失败，请检查上游服务";
            throw new WeKnoraError(`HTTP_${status}`, hint);
          }
          if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") {
            throw new WeKnoraError("UNSUPPORTED_ENCODING", "网关返回了压缩响应，请允许此 API 使用 identity 编码");
          }
          const buffers: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of response) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > maxResponseBytes) {
              throw new WeKnoraError("RESPONSE_TOO_LARGE", "响应超过上限，请缩小 page_size 或 limit");
            }
            buffers.push(buffer);
          }
          let value: RecordData;
          try { value = record(JSON.parse(Buffer.concat(buffers).toString("utf8"))); }
          catch { throw new WeKnoraError("INVALID_RESPONSE", "API 未返回有效 JSON 对象，请检查网关和地址"); }
          if (value.success !== true || !("data" in value)) {
            // Do not echo upstream errors, which may contain credentials or HTML.
            throw new WeKnoraError("API_ERROR", "WeKnora 返回业务错误或不兼容的响应，请检查版本及权限");
          }
          resolve(value);
        } catch (error) {
          reject(error instanceof WeKnoraError ? error : new WeKnoraError(
            "NETWORK_ERROR", "响应中断或超时，请检查网络、证书及上游服务",
          ));
        } finally {
          response.destroy();
        }
      });
      request.on("error", (error: Error) => reject(new WeKnoraError(
        error.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR",
        "请求超时或连接失败，请检查内网连通性、证书和 API 地址",
      )));
      request.end(payload);
    });
  }
}
