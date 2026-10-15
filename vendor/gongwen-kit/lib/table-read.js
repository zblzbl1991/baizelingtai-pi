"use strict";
/**
 * table-read.js —— docx 数据表单元格读取的公共部分（2026-09-14 立）。
 *
 * 为什么抽出来：`check-num.js` 与 `check-doc.js` 各写了一遍 `<w:tc>` 解析，
 * 同一个合并格（w:gridSpan）盲区因此要修两遍——「合计行少一格」的假阳性
 * 就是这么来的（check-num 先踩，check-doc 同款未爆）。读取只有一份源，判据各自保留。
 *
 * **合并格按真实列位展开**：合并格占其起始列，其后补 null（不是空串——空串
 * 在 check-doc 里是「该写一字线的空格」，null 是「这里没有格」）。
 */

// 一个单元格碎片里的可见文本。`<w:tab/>` 还原成空格。
function textOf(frag) {
  return (frag.match(/<w:t[^>]*>[^<]*<\/w:t>|<w:tab\/>/g) || [])
    .map((m) => (m === "<w:tab\/>" ? " " : m.replace(/<[^>]+>/g, ""))).join("").trim();
}

// 把 <w:tr> 拆成 [{ tc, span }]，span 取 w:gridSpan（默认 1）。
function splitCells(tr) {
  return (tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || []).map((tc) => ({
    tc,
    span: Number((tc.match(/<w:gridSpan[^>]*w:val="(\d+)"/) || [])[1] || 1),
  }));
}

// 一行展开成按真实列位排布的数组：mapFn(tcFragment) 取值，合并位补 null。
function rowCells(tr, mapFn) {
  const cells = [];
  for (const { tc, span } of splitCells(tr)) {
    cells.push(mapFn(tc));
    for (let s = 1; s < span; s++) cells.push(null);
  }
  return cells;
}

module.exports = { textOf, splitCells, rowCells };
