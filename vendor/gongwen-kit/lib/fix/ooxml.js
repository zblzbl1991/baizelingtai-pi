"use strict";
/**
 * ooxml.js —— 按 schema 顺序改 rPr／pPr 的子元素。
 * OOXML 的属性子元素有固定次序，次序错了 Word 可能报「文件已损坏」。
 * 改法：拆成子元素列表 → 删、设 → 按 ECMA-376 的次序重排；不认识的元素保留原相对位置，排在已知元素之后。
 */
const { elementAt } = require("./runs");

const RPR_ORDER = ["w:rStyle", "w:rFonts", "w:b", "w:bCs", "w:i", "w:iCs", "w:caps", "w:smallCaps", "w:strike",
  "w:dstrike", "w:outline", "w:shadow", "w:emboss", "w:imprint", "w:noProof", "w:snapToGrid", "w:vanish",
  "w:webHidden", "w:color", "w:spacing", "w:w", "w:kern", "w:position", "w:sz", "w:szCs", "w:highlight", "w:u",
  "w:effect", "w:bdr", "w:shd", "w:fitText", "w:vertAlign", "w:rtl", "w:cs", "w:em", "w:lang",
  "w:eastAsianLayout", "w:specVanish", "w:oMath", "w:rPrChange"];
const PPR_ORDER = ["w:pStyle", "w:keepNext", "w:keepLines", "w:pageBreakBefore", "w:framePr", "w:widowControl",
  "w:numPr", "w:suppressLineNumbers", "w:pBdr", "w:shd", "w:tabs", "w:suppressAutoHyphens", "w:kinsoku",
  "w:wordWrap", "w:overflowPunct", "w:topLinePunct", "w:autoSpaceDE", "w:autoSpaceDN", "w:bidi",
  "w:adjustRightInd", "w:snapToGrid", "w:spacing", "w:ind", "w:contextualSpacing", "w:mirrorIndents",
  "w:suppressOverlap", "w:jc", "w:textDirection", "w:textAlignment", "w:textboxTightWrap", "w:outlineLvl",
  "w:divId", "w:cnfStyle", "w:rPr", "w:sectPr", "w:pPrChange"];

function children(inner) {
  const out = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] !== "<") { const n = inner.indexOf("<", i); i = n < 0 ? inner.length : n; continue; }
    const [name, end] = elementAt(inner, i);
    out.push({ name, xml: inner.slice(i, end) });
    i = end;
  }
  return out;
}

/** 改一段属性的内部 XML。set：{ 元素名: 新 XML }；remove：[元素名]。返回新的内部 XML。 */
function editProps(inner, order, { set = {}, remove = [] } = {}) {
  let kids = children(inner).filter((k) => !remove.includes(k.name) && !(k.name in set));
  for (const [name, xml] of Object.entries(set)) if (xml) kids.push({ name, xml });
  const rank = (n) => { const r = order.indexOf(n); return r < 0 ? order.length : r; };
  kids = kids.map((k, i) => ({ ...k, i })).sort((a, b) => rank(a.name) - rank(b.name) || a.i - b.i);
  return kids.map((k) => k.xml).join("");
}

/** 找第一个名为 name 的元素（按嵌套深度配对，不会被里层同名元素截断）。返回 { start, end } 或 null。 */
function findElement(xml, name, from = 0) {
  const re = new RegExp(`<${name}(?=[\\s>/])`, "g");
  re.lastIndex = from;
  const m = re.exec(xml);
  if (!m) return null;
  return { start: m.index, end: elementAt(xml, m.index)[1] };
}

/** 段落的 pPr 内部改一遍；没有 pPr 就建一个（紧跟 <w:p> 开标签）。 */
function editParaPPr(paraXml, op) {
  const open = paraXml.match(/^<w:p(?:\s[^>]*)?>/)[0];
  const f = findElement(paraXml, "w:pPr");
  if (!f || f.start !== open.length) {
    const inner = editPPr("", op);
    return inner ? open + `<w:pPr>${inner}</w:pPr>` + paraXml.slice(open.length) : paraXml;
  }
  const el = paraXml.slice(f.start, f.end);
  const inner = el === "<w:pPr/>" ? "" : el.replace(/^<w:pPr>/, "").replace(/<\/w:pPr>$/, "");
  const now = editPPr(inner, op);
  return paraXml.slice(0, f.start) + (now ? `<w:pPr>${now}</w:pPr>` : "") + paraXml.slice(f.end);
}

/** 段落里每个 run 的 rPr 改一遍。create：没有 rPr 的 run 也建一个。返回 { xml, changed }。 */
function editParaRuns(paraXml, op, { create = false } = {}) {
  let out = "", i = 0, changed = 0;
  const re = /<w:r(?:\s[^>]*)?>/g;
  let m;
  while ((m = re.exec(paraXml))) {
    const at = m.index + m[0].length;
    out += paraXml.slice(i, at);
    i = at;
    const f = paraXml.startsWith("<w:rPr", at) ? findElement(paraXml, "w:rPr", at) : null;
    if (!f && !create) continue;
    const el = f ? paraXml.slice(f.start, f.end) : "";
    const inner = !el || el === "<w:rPr/>" ? "" : el.replace(/^<w:rPr>/, "").replace(/<\/w:rPr>$/, "");
    const now = editRPr(inner, op);
    if (now !== inner) changed++;
    out += now ? `<w:rPr>${now}</w:rPr>` : "";
    if (f) i = f.end;
    re.lastIndex = i;
  }
  return { xml: out + paraXml.slice(i), changed };
}

const editRPr = (inner, op) => editProps(inner, RPR_ORDER, op);
const editPPr = (inner, op) => editProps(inner, PPR_ORDER, op);

module.exports = { editRPr, editPPr, children, findElement, editParaPPr, editParaRuns };
