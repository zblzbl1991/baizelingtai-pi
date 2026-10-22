import http, { type IncomingMessage } from "node:http";
import https from "node:https";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import yauzl from "yauzl";
import { checkAuth, type Settings } from "./config.js";

// The upstream OpenAPI contains inconsistent required fields; validate envelopes at runtime.
export type Data = Record<string, any>;
export const isObject = (value: unknown): value is Data =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const API = "/api/contracts/v3/parser/external/";
export const EXPORTS = {
  markdown: ["md_file/export", ".md"], json: ["json_file/export", ".json"],
  excel: ["excel_file/export", ".xlsx"], word: ["md2word/export", ".docx"],
} as const;
export type ExportFormat = keyof typeof EXPORTS;

export class OcrError extends Error {
  constructor(public code: string | number, message: string, public uncertain = false) {
    super(message);
  }
  override toString(): string {
    return `OCR ${this.code}: ${this.message}${this.uncertain ? " [submission_uncertain=true：请先确认任务，勿自动重提]" : ""}`;
  }
  asData(): Data {
    return { error: { code: this.code, message: this.message }, submission_uncertain: this.uncertain };
  }
}

class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private limit: number) {}
  async take(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => {
          this.queue = this.queue.filter((item) => item !== ready);
          reject(signal?.reason);
        };
        this.queue.push(ready);
        signal?.addEventListener("abort", abort, { once: true });
      });
    } else { this.active++; }
    // A releasing caller transfers its slot directly to the oldest waiter.
    if (signal?.aborted) { this.release(); signal.throwIfAborted(); }
    return () => this.release();
  }
  private release(): void {
    const next = this.queue.shift();
    if (next) next(); else this.active--;
  }
}

export async function archiveExtension(file: string, fallback: string): Promise<string> {
  const handle = await open(file, "r");
  const signature = Buffer.alloc(4);
  try { await handle.read(signature, 0, 4, 0); } finally { await handle.close(); }
  if (signature[0] !== 0x50 || signature[1] !== 0x4b) return fallback;
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) { reject(new OcrError("INVALID_EXPORT", "导出 ZIP 文件损坏")); return; }
      const names = new Set<string>();
      let count = 0;
      zip.on("error", () => reject(new OcrError("INVALID_EXPORT", "导出 ZIP 目录损坏")));
      zip.on("entry", (entry: yauzl.Entry) => {
        names.add(entry.fileName);
        if (++count > 10000) { zip.close(); resolve(".zip"); } else zip.readEntry();
      });
      zip.on("end", () => resolve(names.has("[Content_Types].xml")
        ? names.has("xl/workbook.xml") ? ".xlsx" : names.has("word/document.xml") ? ".docx" : ".zip"
        : ".zip"));
      zip.readEntry();
    });
  });
}

export class OcrClient {
  private slots: Semaphore;
  constructor(public settings: Settings) {
    this.slots = new Semaphore(settings.maxConcurrentRequests);
  }

  private decode(raw: Buffer): Data {
    let data: unknown;
    try { data = JSON.parse(raw.toString("utf8")); } catch {
      throw new OcrError("INVALID_RESPONSE", "OCR 返回的内容不是有效 JSON");
    }
    if (!isObject(data) || !("code" in data)) throw new OcrError("INVALID_RESPONSE", "缺少 code");
    if (String(data.code) !== "200") throw new OcrError(data.code, String(data.msg || "请求失败").slice(0, 500));
    return data;
  }

  private async perform<T>(
    method: string, endpoint: string, params: Data, body: Buffer | AsyncIterable<Buffer> | undefined,
    contentType: string | undefined, contentLength: number | undefined,
    consume: (response: IncomingMessage) => Promise<T>, signal?: AbortSignal,
  ): Promise<T> {
    checkAuth(this.settings);
    const release = await this.slots.take(signal);
    try {
      const url = new URL(`${this.settings.baseUrl}${API}${endpoint}`);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
      const headers: Record<string, string> = {};
      if (this.settings.apiKey) headers["x-api-key"] = this.settings.apiKey;
      if (contentType) headers["content-type"] = contentType;
      if (contentLength !== undefined) headers["content-length"] = String(contentLength);
      // Native HTTP ignores HTTP_PROXY; no redirects or automatic retries.
      const req = (url.protocol === "https:" ? https : http).request(url, {
        method, headers, agent: false, signal,
      });
      const timer = setTimeout(() => req.destroy(new Error("CONNECT_TIMEOUT")), this.settings.connectTimeout * 1000);
      req.once("socket", (socket) => {
        socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => clearTimeout(timer));
      });
      req.setTimeout(this.settings.readTimeout * 1000, () => req.destroy(new Error("IDLE_TIMEOUT")));
      const response = new Promise<IncomingMessage>((resolve, reject) => {
        req.once("response", resolve);
        req.on("error", reject);
      });
      if (body && !Buffer.isBuffer(body)) {
        // Destroying the request also closes the file stream through pipeline.
        void pipeline(Readable.from(body), req).catch((error: Error) => { req.destroy(error); });
      } else req.end(body);
      try {
        const res = await response;
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          res.destroy();
          throw new OcrError(`HTTP_${res.statusCode}`, "OCR HTTP 请求失败，请检查地址、鉴权和网关");
        }
        // Do not accept compressed data without a decompressed size budget.
        if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
          res.destroy();
          throw new OcrError("INVALID_RESPONSE", "上游返回压缩响应，请关闭该接口的网关压缩");
        }
        return await consume(res);
      } finally { clearTimeout(timer); req.destroy(); }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof OcrError) throw error;
      throw new OcrError("NETWORK_ERROR", "无法连接 OCR 或请求超时，请检查内网/VPN 和服务地址");
    } finally { release(); }
  }

  async request(method: string, endpoint: string, options: {
    params?: Data; json?: Data; body?: AsyncIterable<Buffer>; contentType?: string;
    contentLength?: number; submission?: boolean; signal?: AbortSignal;
  } = {}): Promise<Data> {
    const json = options.json ? Buffer.from(JSON.stringify(options.json)) : undefined;
    try {
      return await this.perform(method, endpoint, options.params || {}, options.body || json,
        options.contentType || (json ? "application/json" : undefined),
        options.contentLength ?? json?.length, async (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of response) {
            size += chunk.length;
            if (size > this.settings.maxResponseMb * 1024 ** 2) throw new OcrError("RESPONSE_TOO_LARGE", "请缩小页数或使用导出");
            chunks.push(chunk);
          }
          return this.decode(Buffer.concat(chunks));
        }, options.signal);
    } catch (error) {
      if (options.submission && error instanceof OcrError && (
        ["NETWORK_ERROR", "INVALID_RESPONSE", "RESPONSE_TOO_LARGE"].includes(String(error.code))
        || String(error.code).startsWith("HTTP_5")
      )) error.uncertain = true;
      throw error;
    }
  }

  async create(file: string, params: Data): Promise<string[]> {
    const boundary = `ocr-${randomUUID()}`;
    const name = path.basename(file).replace(/["\\\r\n]/g, "_");
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="documents"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const size = (await stat(file)).size;
    async function* upload(): AsyncGenerator<Buffer> {
      yield head;
      const stream = createReadStream(file);
      try { for await (const chunk of stream) yield chunk as Buffer; } finally { stream.destroy(); }
      yield tail;
    }
    const response = await this.request("POST", "task/create", {
      params, body: upload(), contentType: `multipart/form-data; boundary=${boundary}`,
      contentLength: head.length + size + tail.length, submission: true,
    });
    const ids = isObject(response.data) ? response.data.task_ids : undefined;
    if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === "string" && id)) {
      throw new OcrError("INVALID_RESPONSE", "创建响应缺少 task_ids，请先检查 OCR 页面", true);
    }
    return ids;
  }

  async result(taskId: string, pageStart: number, pageCount: number, signal?: AbortSignal): Promise<Data> {
    const response = await this.request("POST", "result", {
      json: { task_id: taskId, page_start: pageStart, page_count: pageCount }, signal,
    });
    if (!isObject(response.data)) throw new OcrError("INVALID_RESPONSE", "结果响应缺少 data 对象");
    return response.data;
  }

  async export(taskId: string, format: ExportFormat, outputDir: string): Promise<string> {
    checkAuth(this.settings);
    await mkdir(outputDir, { recursive: true });
    const stem = path.join(outputDir, randomUUID());
    const partial = `${stem}.part`;
    const body = Buffer.from(JSON.stringify({ task_ids: [taskId] }));
    try {
      const size = await this.perform("POST", EXPORTS[format][0], {}, body, "application/json", body.length,
        async (response) => {
          const handle = await open(partial, "wx");
          let size = 0;
          try {
            for await (const chunk of response) {
              size += chunk.length;
              if (size > this.settings.maxExportMb * 1024 ** 2) throw new OcrError("EXPORT_TOO_LARGE", "导出超过大小上限");
              await handle.writeFile(chunk);
            }
          } finally { await handle.close(); }
          return size;
        });
      if (!size) throw new OcrError("EMPTY_EXPORT", "OCR 返回空文件");
      const handle = await open(partial, "r");
      const prefix = Buffer.alloc(128);
      let bytesRead: number;
      try { ({ bytesRead } = await handle.read(prefix, 0, 128, 0)); } finally { await handle.close(); }
      const text = prefix.subarray(0, bytesRead).toString("utf8").trimStart();
      if (/^<(?:html|!doctype)/i.test(text)) throw new OcrError("INVALID_EXPORT", "导出接口返回 HTML");
      if (text.startsWith("{") && size <= this.settings.maxResponseMb * 1024 ** 2) {
        let parsed: unknown;
        try { parsed = JSON.parse(await readFile(partial, "utf8")); } catch { /* Not an envelope. */ }
        if (isObject(parsed) && "code" in parsed && "msg" in parsed) {
          this.decode(await readFile(partial));
          throw new OcrError("INVALID_EXPORT", "接口返回状态对象，未返回文件");
        }
      }
      const extension = await archiveExtension(partial, EXPORTS[format][1]);
      const output = `${stem}${extension}`;
      await rename(partial, output);
      return output;
    } finally { await unlink(partial).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; }); }
  }
}
