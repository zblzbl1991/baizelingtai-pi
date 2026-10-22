import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { inputFile, type Settings } from "./config.js";
import { isObject, OcrClient, OcrError, type Data, type ExportFormat } from "./client.js";

const STATUSES: Record<string, string> = {
  "0": "queued", "1": "processing", "2": "succeeded", "3": "quota_exhausted",
  "4": "aborted", "-1": "failed",
};
const BUSINESS: Record<string, string> = {
  "10702": "processing", "10703": "failed", "40429": "quota_exhausted",
};
const TERMINAL = new Set(["succeeded", "quota_exhausted", "aborted", "failed"]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function statusInfo(data: Data): Data {
  return { status: STATUSES[String(data.status)] || "unknown", upstream_status: data.status ?? null };
}
function textBlocks(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(textBlocks);
  if (!isObject(node)) return [];
  if (typeof node.text === "string") return [node.text];
  return ["structured", "blocks", "content"].flatMap((key) => textBlocks(node[key]));
}
function tables(node: unknown): Data[] {
  if (Array.isArray(node)) return node.flatMap(tables);
  if (!isObject(node)) return [];
  return node.type === "table" ? [node] : Object.values(node).flatMap(tables);
}

// Match Python's Unicode character offsets, including emoji outside the BMP.
export function characterChunk(content: string, offset: number, limit: number): Data {
  const selected: string[] = [];
  let total = 0;
  for (const character of content) {
    if (total >= offset && total < offset + limit) selected.push(character);
    total++;
  }
  if (offset > total) throw new Error(`offset 超过结果长度 ${total}`);
  const end = Math.min(total, offset + limit);
  return { content: selected.join(""), offset, next_offset: end < total ? end : null,
    truncated: end < total, total_chars: total };
}

export class OcrService {
  readonly outputDir: string;
  readonly taskDir: string;
  constructor(public settings: Settings, public client = new OcrClient(settings)) {
    this.outputDir = path.join(settings.dataDir, "outputs");
    this.taskDir = path.join(settings.dataDir, "node-tasks");
  }
  private taskFile(id: string): string { return path.join(this.taskDir, `${digest(id)}.json`); }
  async knownTask(id: string): Promise<void> {
    try {
      const saved: unknown = JSON.parse(await readFile(this.taskFile(id), "utf8"));
      if (isObject(saved) && saved.task_id === id) return;
    } catch { /* Unknown, corrupted, or incomplete records are never trusted. */ }
    throw new Error("未知任务；本实例只访问自身提交并记录的任务");
  }
  async record(ids: string[], fileName: string): Promise<void> {
    await mkdir(this.taskDir, { recursive: true });
    for (const id of ids) {
      try {
        await writeFile(this.taskFile(id), JSON.stringify({
          task_id: id, file_name: fileName, created_at: Date.now() / 1000,
        }), { flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.knownTask(id);
      }
    }
  }
  async parse(args: {
    file_path: string; parse_type: string; parse_mode: string; page_start: number;
    page_count: number; wait_seconds: number; pdf_password?: string | null;
  }): Promise<Data> {
    const file = await inputFile(args.file_path, this.settings);
    const params: Data = {
      parse_type: args.parse_type, parse_mode: args.parse_mode,
      page_start: args.page_start, page_count: args.page_count,
      char_details: "0", markdown_details: "1", get_image: "none",
      table_flavor: "html", apply_document_tree: "1",
    };
    if (args.pdf_password) params.pdf_pwd = args.pdf_password;
    const ids = await this.client.create(file, params);
    const result: Data = { task_ids: ids, status: "submitted" };
    try { await this.record(ids, path.basename(file)); } catch {
      // A successful remote submission must remain visible even if local disk fails.
      return { ...result, registry_error: "任务已创建，但本地记录失败；保留 ID 并在 OCR 页面核对，勿重提" };
    }
    if (args.wait_seconds > 0) {
      const signal = AbortSignal.timeout(Math.max(1, Math.ceil(args.wait_seconds * 1000)));
      const states = new Map<string, Data>();
      try {
        while (true) {
          signal.throwIfAborted();
          for (const id of ids) {
            if (!TERMINAL.has(states.get(id)?.status)) states.set(id, await this.task(id, signal));
          }
          if ([...states.values()].every((state) => TERMINAL.has(state.status))) break;
          await sleep(this.settings.pollInterval * 1000, undefined, { signal });
        }
      } catch (error) {
        if (signal.aborted) result.wait_expired = true;
        else result.poll_error = String(error).slice(0, 600);
      }
      result.tasks = [...states.values()];
      if (states.size === ids.length) {
        const statuses = new Set([...states.values()].map((state) => state.status));
        result.status = statuses.size === 1 ? [...statuses][0] : "mixed";
      }
    }
    return result;
  }

  async task(id: string, signal?: AbortSignal): Promise<Data> {
    await this.knownTask(id);
    try {
      const data = await this.client.result(id, 1, 1, signal);
      return { task_id: id, ...statusInfo(data), doc_name: data.doc_name ?? null,
        total_count: data.total_count ?? null, message: data.reasons_for_failure ?? null };
    } catch (error) {
      if (error instanceof OcrError && BUSINESS[String(error.code)]) {
        return { task_id: id, status: BUSINESS[String(error.code)], message: error.message };
      }
      throw error;
    }
  }

  async result(args: {
    task_id: string; format: "markdown" | "json" | "tables"; page_start: number;
    page_count: number; offset: number; max_chars: number;
  }): Promise<Data> {
    await this.knownTask(args.task_id);
    let data: Data;
    try { data = await this.client.result(args.task_id, args.page_start, args.page_count); }
    catch (error) {
      if (error instanceof OcrError && BUSINESS[String(error.code)]) {
        return { task_id: args.task_id, status: BUSINESS[String(error.code)], message: error.message };
      }
      throw error;
    }
    const info: Data = { task_id: args.task_id, ...statusInfo(data) };
    if (info.status !== "succeeded") return { ...info, message: data.reasons_for_failure ?? null };
    const parsed = data.parse_result ?? {};
    if (!isObject(parsed)) throw new OcrError("INVALID_RESPONSE", "parse_result 必须是对象");
    const pages: Data[] = Array.isArray(parsed.pages) ? parsed.pages.filter(isObject) : [];
    const warnings: string[] = [];
    let content: string;
    if (args.format === "markdown") {
      if (typeof parsed.markdown === "string") content = parsed.markdown;
      else {
        content = (Array.isArray(parsed.md_detail) ? parsed.md_detail : [])
          .filter((part: unknown) => isObject(part) && typeof part.text === "string")
          .map((part: Data) => part.text).join("\n\n");
        if (!content) {
          content = textBlocks(pages).join("\n\n");
          warnings.push("未返回 md_detail，已从页面结构提取文本；原始结构见 JSON");
        }
      }
    } else content = JSON.stringify(args.format === "json" ? data : {
      pages: pages.map((page) => ({ page_id: page.page_id, tables: tables(page.structured) })),
    }, null, 2);
    const chunk = characterChunk(content, args.offset, Math.min(args.max_chars, this.settings.maxInlineChars));
    await mkdir(this.outputDir, { recursive: true });
    const artifact = path.join(this.outputDir, `${digest(content)}${args.format === "markdown" ? ".md" : ".json"}`);
    try { await writeFile(artifact, content, { encoding: "utf8", flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return { ...info, format: args.format, page_start: args.page_start, page_count: args.page_count,
      is_whole: data.is_whole ?? false, total_count: data.total_count ?? null, ...chunk,
      artifact_path: artifact, warnings, content_is_untrusted_document_data: true };
  }

  async export(id: string, format: ExportFormat): Promise<Data> {
    await this.knownTask(id);
    const file = await this.client.export(id, format, this.outputDir);
    return { task_id: id, format, artifact_path: file, size_bytes: (await stat(file)).size,
      actual_extension: path.extname(file) };
  }

  async health(): Promise<Data> {
    const base = { base_url: this.settings.baseUrl, api_key_configured: !!this.settings.apiKey,
      anonymous_enabled: this.settings.allowAnonymous, input_roots: this.settings.inputRoots,
      output_dir: this.outputDir };
    try {
      await this.client.request("GET", "task/list", { params: { page: 1, page_size: 1 } });
      return { ...base, ok: true };
    } catch (error) {
      return { ...base, ok: false, ...(error instanceof OcrError ? error.asData() : {
        error: { code: "CONFIG_ERROR", message: (error as Error).message },
      }) };
    }
  }
}
