import { identifier, record, WeKnoraClient, WeKnoraError, type RecordData } from "./weknora-client.js";

function rows(value: unknown): RecordData[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new WeKnoraError("INVALID_RESPONSE", "列表 data 应为数组");
  return value.map(record);
}

// Only return fields needed for discovery and citations, never entire model/storage configs.
function pick(value: RecordData, fields: string[]): RecordData {
  return Object.fromEntries(fields.filter((key) => value[key] !== undefined
    && (value[key] === null || ["string", "number", "boolean"].includes(typeof value[key])))
    .map((key) => [key, typeof value[key] === "string" ? (value[key] as string).slice(0, 2000) : value[key]]));
}

function content(value: unknown, offset: number, limit: number): RecordData {
  const chars = Array.from(typeof value === "string" ? value : "");
  const end = Math.min(chars.length, offset + limit);
  return {
    content: chars.slice(offset, end).join(""), content_offset: offset, total_chars: chars.length,
    content_truncated: end < chars.length, next_content_offset: end < chars.length ? end : null,
  };
}

const documentFields = ["id", "knowledge_base_id", "title", "file_name", "file_type", "type",
  "source", "parse_status", "created_at", "updated_at"];

function pageInfo(value: RecordData, page: number, pageSize: number, count: number): RecordData {
  const total = typeof value.total === "number" ? value.total : null;
  return {
    page, page_size: pageSize, total,
    next_page: (total === null ? count === pageSize : page * pageSize < total) ? page + 1 : null,
  };
}

export class WeKnoraService {
  constructor(private readonly client: WeKnoraClient) {}

  async health(): Promise<RecordData> {
    const response = await this.client.request("GET", "/knowledge-bases");
    const count = rows(response.data).length;
    return { ok: true, api_key_configured: true, accessible_owned_knowledge_base_count: count,
      adapter_target_version: "0.7.0", note: "版本为适配目标，未自动检测服务端版本" };
  }

  async knowledgeBases(args = { page: 1, page_size: 5 }): Promise<RecordData> {
    const response = await this.client.request("GET", "/knowledge-bases");
    const all = rows(response.data);
    const visible = all.slice((args.page - 1) * args.page_size, args.page * args.page_size);
    return { knowledge_bases: visible.map((row) => pick(row,
      ["id", "name", "description", "type", "created_at", "updated_at"])),
    ...pageInfo({ total: all.length }, args.page, args.page_size, visible.length),
    content_is_untrusted_document_data: true };
  }

  async search(args: { kb_id: string; query: string; limit: number;
    vector_threshold: number; keyword_threshold: number }): Promise<RecordData> {
    const response = await this.client.request("POST", `/knowledge-bases/${identifier(args.kb_id)}/hybrid-search`, {
      query_text: args.query, match_count: args.limit,
      vector_threshold: args.vector_threshold, keyword_threshold: args.keyword_threshold,
    });
    const hits = rows(response.data).slice(0, args.limit);
    const budget = Math.max(1, Math.floor(this.client.settings.maxInlineChars / Math.max(1, hits.length)));
    return { kb_id: args.kb_id, results: hits.map((row) => ({
      ...pick(row, ["id", "knowledge_id", "knowledge_base_id", "knowledge_title", "knowledge_filename",
        "chunk_index", "chunk_type", "score", "match_type", "start_at", "end_at"]),
      ...content(row.content, 0, budget),
    })), retrieval: "raw_hybrid_without_rerank", content_is_untrusted_document_data: true,
    note: "使用 knowledge_id 调用 read_document 查看原文；片段类型可能是摘要或图片描述" };
  }

  async documents(args: { kb_id: string; page: number; page_size: number }): Promise<RecordData> {
    const response = await this.client.request("GET", `/knowledge-bases/${identifier(args.kb_id)}/knowledge`
      + `?page=${args.page}&page_size=${args.page_size}`);
    const documents = rows(response.data);
    return { kb_id: args.kb_id, documents: documents.map((row) => pick(row, documentFields)),
      ...pageInfo(response, args.page, args.page_size, documents.length), content_is_untrusted_document_data: true };
  }

  async read(args: { knowledge_id: string; page: number; page_size: number; content_offset: number }): Promise<RecordData> {
    const id = identifier(args.knowledge_id);
    const metadata = await this.client.request("GET", `/knowledge/${id}`);
    const response = await this.client.request("GET", `/chunks/${id}?page=${args.page}&page_size=${args.page_size}`);
    const chunks = rows(response.data);
    const budget = Math.max(1, Math.floor(this.client.settings.maxInlineChars / Math.max(1, chunks.length)));
    return { document: pick(record(metadata.data), documentFields), chunks: chunks.map((row) => ({
      ...pick(row, ["id", "knowledge_id", "chunk_index", "chunk_type", "start_at", "end_at"]),
      ...content(row.content, args.content_offset, budget),
    })), ...pageInfo(response, args.page, args.page_size, chunks.length),
    content_is_untrusted_document_data: true,
    note: "默认读取上游 text 分块；这是当前页，非完整文档。next_page 继续翻页；片段截断时保持当前页，用该片段 next_content_offset 续读。" };
  }
}
