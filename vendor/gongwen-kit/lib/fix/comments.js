"use strict";
/**
 * comments.js —— 把机检剩下的问题写成 Word 批注（tools/fix-doc.js 用）。
 *
 * 批注挂在整段上：锚点是命中处的原文片段，找到含它的第一个段落；锚点带表格
 * 序号的，只在那张表里找。找不到的挂到正文第一段，批注里写明「位置未定位」。
 */
const { encode, decode } = require("./runs");
const { findElement } = require("./ooxml");

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
const CT = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";

// 段落表：位置、可见文字（已接受修订的视角：w:t 有，w:delText 没有）、所在表格序号
function paragraphsOf(xml) {
  const tbls = [];
  for (const m of xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)) tbls.push([m.index, m.index + m[0].length]);
  const out = [];
  for (const m of xml.matchAll(/<w:p(?:\s[^>]*)?>(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g)) {
    const text = decode((m[0].match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) || []).map((t) => t.replace(/<[^>]+>/g, "")).join(""));
    const table = tbls.findIndex(([a, b]) => m.index >= a && m.index < b);
    out.push({ at: m.index, len: m[0].length, text, table });
  }
  return out;
}

/**
 * items：[{ text, anchors }]。返回 { xml, comments: 新的 comments.xml, placed, unplaced }。
 * existing：原有 comments.xml（可为空）。startId：可用的第一个 id。
 */
function addComments(docXml, items, { existing, startId, author, date }) {
  const paras = paragraphsOf(docXml);
  const firstText = paras.findIndex((p) => p.text.trim());
  const byPara = new Map();   // 段落序号 → [批注]
  let id = startId;
  let unplaced = 0;
  const bodies = [];
  for (const it of items) {
    let k = -1;
    for (const a of it.anchors || []) {
      const t = typeof a === "string" ? a : a.text;
      const tb = typeof a === "string" ? undefined : a.table;
      if (!t || !t.trim()) continue;
      // 机检按 </w:p> 切段，文本框里的段落会和外层段落拼成一句：整句找不到就用开头一截找
      const want = decode(t.trim());
      const inScope = (p) => tb === undefined || p.table === tb;
      k = paras.findIndex((p) => p.text.includes(want) && inScope(p));
      if (k < 0 && want.length > 12) k = paras.findIndex((p) => p.text.includes(want.slice(0, 12)) && inScope(p));
      if (k < 0 && tb !== undefined) k = paras.findIndex((p) => p.table === tb && p.text.trim());
      if (k >= 0) break;
    }
    let text = it.text;
    if (k < 0) { k = firstText < 0 ? 0 : firstText; unplaced++; text += "（位置未定位，挂在首段）"; }
    const cid = id++;
    (byPara.get(k) || byPara.set(k, []).get(k)).push(cid);
    bodies.push(`<w:comment w:id="${cid}" w:author="${author}" w:date="${date}" w:initials="GK">`
      + `<w:p><w:r><w:t xml:space="preserve">${encode(text)}</w:t></w:r></w:p></w:comment>`);
  }
  // 从后往前改段落
  let xml = docXml;
  for (const k of [...byPara.keys()].sort((a, b) => b - a)) {
    const p = paras[k];
    let s = xml.slice(p.at, p.at + p.len);
    const ids = byPara.get(k);
    const starts = ids.map((i) => `<w:commentRangeStart w:id="${i}"/>`).join("");
    const ends = ids.map((i) => `<w:commentRangeEnd w:id="${i}"/><w:r><w:commentReference w:id="${i}"/></w:r>`).join("");
    // 批注起点放在段落属性之后（pPr 里可能嵌着修订前的旧 pPr，按深度配对找结尾）
    const open = s.match(/^<w:p(?:\s[^>]*)?>/)[0];
    const f = findElement(s, "w:pPr");
    const at = f && f.start === open.length ? f.end : open.length;
    s = s.slice(0, at) + starts + s.slice(at);
    s = s.replace(/<\/w:p>$/, `${ends}</w:p>`);
    xml = xml.slice(0, p.at) + s + xml.slice(p.at + p.len);
  }
  const comments = existing
    ? existing.replace(/<\/w:comments>\s*$/, bodies.join("") + "</w:comments>").replace(/<w:comments([^>]*)\/>\s*$/, `<w:comments$1>${bodies.join("")}</w:comments>`)
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W_NS}>${bodies.join("")}</w:comments>`;
  return { xml, comments, placed: items.length - unplaced, unplaced };
}

/** 关系与内容类型里补上 comments 部件（已有就不动）。 */
function registerComments(rels, types) {
  let r = rels;
  if (!r.includes(REL)) r = r.replace(/<\/Relationships>/, `<Relationship Id="rIdGwComments" Type="${REL}" Target="comments.xml"/></Relationships>`);
  let t = types;
  if (!t.includes("/word/comments.xml")) t = t.replace(/<\/Types>/, `<Override PartName="/word/comments.xml" ContentType="${CT}"/></Types>`);
  return { rels: r, types: t };
}

module.exports = { addComments, registerComments, paragraphsOf };
