"use strict";
/**
 * runs.js —— 段落的文字模型与修订痕迹（tools/fix-doc.js 用）。
 *
 * 一个段落拆成顶层子元素：段落属性、纯文字 run、零宽标记（书签、批注范围、
 * 拼写标记）、其余一律算「不透明」（超链接、域、已有修订、图片、制表符……）。
 * 纯文字 run 的字拼成段落文本，不透明元素占一个 U+FFFC。改动只在纯文字上做：
 * 碰到 U+FFFC 的改动不做，留给批注——宁可不改，不能改坏。
 *
 * 改动写成 Word 修订（w:del／w:ins），写稿人逐条接受或拒绝；全部拒绝必须
 * 还原成原文，这条由 tests/fix.js 断言。
 */

const OPAQUE = "￼";
const ZERO_WIDTH = new Set([
  "w:proofErr", "w:bookmarkStart", "w:bookmarkEnd", "w:commentRangeStart",
  "w:commentRangeEnd", "w:permStart", "w:permEnd", "w:moveFromRangeStart",
  "w:moveFromRangeEnd", "w:moveToRangeStart", "w:moveToRangeEnd",
]);

const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&amp;/g, "&");
const encode = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 从 i 处的开标签起，找到同名元素的结尾（按嵌套深度配对）。返回 [名字, 结尾位置]。
function elementAt(xml, i) {
  const m = /^<([\w:]+)[^>]*?(\/?)>/.exec(xml.slice(i, i + 2000));
  if (!m) throw new Error("段落 XML 解析失败：" + xml.slice(i, i + 60));
  const name = m[1];
  if (m[2] === "/") return [name, i + m[0].length];
  const open = new RegExp(`<${name}(?=[\\s>/])`, "g");
  const close = `</${name}>`;
  let depth = 1, j = i + m[0].length;
  while (depth) {
    open.lastIndex = j;
    const o = open.exec(xml);
    const c = xml.indexOf(close, j);
    if (c < 0) throw new Error(`段落 XML 里 ${name} 没有闭合`);
    if (o && o.index < c) {
      // 自闭合的同名元素不加深度
      const end = xml.indexOf(">", o.index);
      if (xml[end - 1] !== "/") depth++;
      j = end + 1;
    } else { depth--; j = c + close.length; }
  }
  return [name, j];
}

/** 纯文字 run：只含 rPr、w:t、lastRenderedPageBreak。返回 { rPr, text } 或 null。 */
function plainRun(xml) {
  const inner = xml.replace(/^<w:r(?:\s[^>]*)?>/, "").replace(/<\/w:r>$/, "");
  const rPr = (inner.match(/^<w:rPr>[\s\S]*?<\/w:rPr>|^<w:rPr\/>/) || [""])[0];
  const rest = inner.slice(rPr.length).replace(/<w:lastRenderedPageBreak\/>/g, "");
  let text = "";
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:t\/>/y;
  let pos = 0;
  while (pos < rest.length) {
    re.lastIndex = pos;
    const m = re.exec(rest);
    if (!m) return null;
    text += decode(m[1] || "");
    pos = re.lastIndex;
  }
  return { rPr, text };
}

/** 拆一个段落。返回 { open, close, tokens, text, map }。map[k] = 字所在 token 序号。 */
function parseParagraph(xml) {
  const open = xml.match(/^<w:p(?:\s[^>]*)?>/)[0];
  const close = "</w:p>";
  const body = xml.slice(open.length, xml.length - close.length);
  const tokens = [];
  let i = 0;
  while (i < body.length) {
    if (body[i] !== "<") {   // 元素之间的空白
      const n = body.indexOf("<", i);
      tokens.push({ kind: "raw", xml: body.slice(i, n < 0 ? body.length : n) });
      i = n < 0 ? body.length : n;
      continue;
    }
    const [name, end] = elementAt(body, i);
    const frag = body.slice(i, end);
    i = end;
    if (name === "w:pPr") tokens.push({ kind: "raw", xml: frag });
    else if (ZERO_WIDTH.has(name)) tokens.push({ kind: "raw", xml: frag });
    else if (name === "w:r" && plainRun(frag)) tokens.push({ kind: "run", xml: frag, ...plainRun(frag) });
    else tokens.push({ kind: "opaque", xml: frag });
  }
  let text = "";
  const map = [];
  tokens.forEach((t, k) => {
    if (t.kind === "run") { text += t.text; for (let c = 0; c < t.text.length; c++) map.push(k); }
    if (t.kind === "opaque") { text += OPAQUE; map.push(k); }
  });
  return { open, close, tokens, text, map };
}

/**
 * 把改动写成修订。edits：[{ start, end, text }]，按 start 排好、互不重叠；
 * start === end 是纯插入。返回 { xml, applied, skipped }。
 * rev：{ nextId(), author, date }。
 */
function applyEdits(para, edits, rev) {
  const ok = [];
  const skipped = [];
  for (const e of edits) {
    const span = para.text.slice(e.start, e.end);
    // 插入点前后都要是纯文字，改动范围里不能有不透明元素
    const edge = para.text.slice(Math.max(0, e.start - 1), Math.min(para.text.length, e.end + 1));
    if (span.includes(OPAQUE) || (e.start === e.end && edge.includes(OPAQUE))
        || (ok.length && ok[ok.length - 1].end > e.start)) skipped.push(e);
    else ok.push(e);
  }
  if (!ok.length) return { xml: null, applied: [], skipped };

  const attrs = () => `w:id="${rev.nextId()}" w:author="${rev.author}" w:date="${rev.date}"`;
  const runXml = (rPr, text, tag = "w:t") => `<w:r>${rPr}<${tag} xml:space="preserve">${encode(text)}</${tag}></w:r>`;
  const ins = (rPr, text) => (text ? `<w:ins ${attrs()}>${runXml(rPr, text)}</w:ins>` : "");
  const del = (rPr, text) => `<w:del ${attrs()}>${runXml(rPr, text, "w:delText")}</w:del>`;

  let out = para.open;
  let g = 0;            // 段落文本里的全局位置
  let ei = 0;           // 下一条要处理的改动
  for (const t of para.tokens) {
    if (t.kind !== "run") {
      if (t.kind === "opaque") g += 1;
      out += t.xml;
      continue;
    }
    const g0 = g, g1 = g + t.text.length;
    let local = "";     // 当前累积的未改动文字
    const flush = () => { if (local) { out += runXml(t.rPr, local); local = ""; } };
    for (let k = g0; k < g1; k++) {
      // 先处理落在 k 之前的纯插入
      while (ei < ok.length && ok[ei].start === k && ok[ei].end === k) {
        flush(); out += ins(t.rPr, ok[ei].text); ei++;
      }
      const e = ok[ei];
      if (e && k >= e.start && k < e.end) {
        flush();
        // 这条改动在本 run 里覆盖的一段
        const stop = Math.min(e.end, g1);
        out += del(t.rPr, para.text.slice(k, stop));
        k = stop - 1;
        if (stop === e.end) {
          // 插入文字的格式取改动起点所在 run
          const startTok = para.tokens[para.map[e.start]];
          out += ins(startTok.rPr, e.text);
          ei++;
        }
        continue;
      }
      local += para.text[k];
    }
    flush();
    g = g1;
  }
  // 段尾的纯插入
  while (ei < ok.length && ok[ei].start === para.text.length) {
    const last = [...para.tokens].reverse().find((t) => t.kind === "run");
    out = out.replace(/$/, ins(last ? last.rPr : "", ok[ei].text));
    ei++;
  }
  out += para.close;
  return { xml: out, applied: ok, skipped };
}

/** 去掉 run 上的斜体，记成格式修订（w:rPrChange），拒绝时斜体回来。 */
function unitalic(paraXml, rev) {
  let n = 0;
  const xml = paraXml.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/g, (all, inner) => {
    if (!/<w:i\/>|<w:i w:val="(?:1|true|on)"\/>/.test(inner) || /<w:rPrChange/.test(inner)) return all;
    n++;
    const now = inner.replace(/<w:i(?: w:val="(?:1|true|on)")?\/>/g, "").replace(/<w:iCs(?: w:val="(?:1|true|on)")?\/>/g, "");
    return `<w:rPr>${now}<w:rPrChange w:id="${rev.nextId()}" w:author="${rev.author}" w:date="${rev.date}"><w:rPr>${inner}</w:rPr></w:rPrChange></w:rPr>`;
  });
  return { xml, n };
}

module.exports = { parseParagraph, applyEdits, unitalic, OPAQUE, decode, encode, elementAt };
