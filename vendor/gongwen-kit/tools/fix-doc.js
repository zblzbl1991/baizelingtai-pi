#!/usr/bin/env node
/**
 * fix-doc.js —— 修复现成的公文 docx：版式直接改，体例按修订痕迹改，剩下的插批注。
 *
 * 用法：node tools/fix-doc.js 稿子.docx [--out 输出.docx] [--no-layout]
 *       默认输出到同目录「原名-修订.docx」，原文件不动。
 *
 * 三档：
 *   版式      直接改（lib/fix/layout.js）：版心网格、正文与层次标题字体字号、公文标题、页码
 *   体例与规范层文风  改成 Word 修订（lib/fix/text-rules.js）：写稿人逐条接受或拒绝；
 *            全部拒绝等于原文（tests/fix.js 断言）
 *   其余      不改，插批注：数字自洽（合计、跨表、计数与列举）、改法要靠判断的体例项、
 *            碰到域与超链接没法安全改的。数字不自动改——合计错还是分项错，工具判断不了
 *
 * 改完对输出件重跑三道机检，批注就是机检剩下的那些，所以批注与机检口径一致。
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const JSZip = require("jszip");
const { parseParagraph, applyEdits, unitalic } = require("../lib/fix/runs");
const { editsFor } = require("../lib/fix/text-rules");
const { fixStyles, fixDocument, fixPackage, redStyleIds } = require("../lib/fix/layout");
const { addComments, registerComments } = require("../lib/fix/comments");
const checkDoc = require("../checks/check-doc");
const checkNum = require("../checks/check-num");
const { scan } = require("../checks/style-scan");
const { textOf } = require("../lib/table-read");

const AUTHOR = "gongwen-kit";
const TITLE_FONT = process.env.GONGWEN_FONT_TITLE || "方正小标宋简体";

function args() {
  const a = process.argv.slice(2);
  const o = { layout: true };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--out") o.out = a[++i];
    else if (a[i] === "--no-layout") o.layout = false;
    else if (!o.file) o.file = a[i];
  }
  if (!o.file) {
    console.error("用法：node tools/fix-doc.js 稿子.docx [--out 输出.docx] [--no-layout]");
    process.exit(2);
  }
  o.out = o.out || path.join(path.dirname(o.file), path.basename(o.file).replace(/\.docx$/i, "") + "-修订.docx");
  if (path.resolve(o.out) === path.resolve(o.file)) {
    console.error("输出路径和原文件相同，会覆盖原稿。换一个 --out。");
    process.exit(2);
  }
  return o;
}

const read = async (zip, name) => (zip.file(name) ? zip.file(name).async("string") : "");

// 体例修复：逐段算改动、写成修订
function textPass(docXml, styles, headingIds, rev, tally) {
  // 样式自带编号的段落（标题样式里的 numPr）也算有自动编号
  const numberedStyles = new Set();
  for (const m of styles.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    if (/<w:numPr>/.test(m[2])) numberedStyles.add(m[1]);
  }
  const plain = docXml.split("</w:p>").map(textOf).join("\n");
  const spacedDates = /\d\s+年\s+\d/.test(plain);
  let skipped = 0;
  const xml = docXml.replace(/<w:p(?:\s[^>]*)?>(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g, (p) => {
    let para;
    try { para = parseParagraph(p); } catch { return p; }   // 解析不了的段落原样保留
    const sid = (p.match(/<w:pStyle w:val="([^"]+)"/) || [])[1];
    const ctx = {
      spacedDates,
      heading: !!(sid && headingIds[sid]) || /<w:outlineLvl w:val="[0-3]"/.test(p),
      numbered: /<w:numPr>/.test(p) || numberedStyles.has(sid),
    };
    let out = p;
    const edits = editsFor(para.text, ctx);
    if (edits.length) {
      const r = applyEdits(para, edits, rev);
      skipped += r.skipped.length;
      for (const e of r.applied) tally[e.rule] = (tally[e.rule] || 0) + 1;
      if (r.xml) out = r.xml;
    }
    const it = unitalic(out, rev);
    if (it.n) tally["斜体改正体"] = (tally["斜体改正体"] || 0) + it.n;
    return it.xml;
  });
  return { xml, skipped };
}

// 对一份 docx 跑三道机检，收集剩下的问题（带锚点）
async function remaining(file) {
  const items = [];
  const doc = await checkDoc.readDocx(file);
  for (const h of checkDoc.check(file, doc)) items.push({ kind: "体例", ...h });
  const num = await checkNum.check(file);
  for (const h of num) items.push({ kind: "数字", ...h });
  for (const h of num.hints || []) items.push({ kind: "数字提示", ...h });
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const body = (await read(zip, "word/document.xml")).split("</w:p>").map(textOf).filter(Boolean).join("\n")
    .replace(/「[^」\n]*」/g, "　").replace(/“[^”\n]*”/g, "　");
  const st = scan(body);
  st.norm.forEach((line) => items.push({ kind: "文风", rule: "规范", detail: line, anchors: st.anchors }));
  return { items, style: st.style };
}

// 一条命中拆成批注：每个不同的锚点一条，上限 20
function toComments(items) {
  const out = [];
  for (const it of items) {
    const label = it.kind === "数字提示" ? "数字·提示（不一定错，请核对）" : it.kind;
    const text = `【${label}·${it.rule}】${it.detail}`;
    const seen = new Set();
    const anchors = (it.anchors || []).filter((a) => {
      const k = typeof a === "string" ? a : `${a.table}|${a.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (it.kind === "文风" || anchors.length <= 1) { out.push({ text, anchors }); continue; }
    anchors.slice(0, 20).forEach((a) => out.push({ text, anchors: [a] }));
  }
  return out;
}

(async () => {
  const o = args();
  const zip = await JSZip.loadAsync(fs.readFileSync(o.file));
  let docXml = await read(zip, "word/document.xml");
  let styles = await read(zip, "word/styles.xml");
  let rels = await read(zip, "word/_rels/document.xml.rels");
  let types = await read(zip, "[Content_Types].xml");
  let settings = await read(zip, "word/settings.xml");
  const existingComments = await read(zip, "word/comments.xml");
  if (!docXml) { console.error("读不到 word/document.xml，不是 docx？"); process.exit(2); }

  const notes = [];
  let headingIds = {};
  if (o.layout) {
    const redStyles = redStyleIds(styles);
    const s = fixStyles(styles, notes);
    styles = s.xml; headingIds = s.headingIds;
    docXml = fixDocument(docXml, { headingIds, titleFont: TITLE_FONT, redStyles }, notes);
    const pk = fixPackage(zip, { rels, types, settings }, notes);
    ({ rels, types, settings } = pk);
  } else {
    for (const m of styles.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>[\s\S]*?<w:name w:val="heading ([1-4])"/gi)) headingIds[m[1]] = +m[2];
  }

  // 修订与批注共用 id 空间，从文中已有的最大 id 之后开始
  // 不用 Math.max(...ids)：id 上十万个的大文件会超出参数上限
  let next = 1;
  for (const m of (docXml + existingComments).matchAll(/w:id="(\d+)"/g)) if (+m[1] >= next) next = +m[1] + 1;
  const date = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const rev = { nextId: () => next++, author: AUTHOR, date };
  const tally = {};
  const tp = textPass(docXml, styles, headingIds, rev, tally);
  docXml = tp.xml;

  // 写中间件，跑机检
  const put = () => {
    zip.file("word/document.xml", docXml);
    if (styles) zip.file("word/styles.xml", styles);
    if (rels) zip.file("word/_rels/document.xml.rels", rels);
    if (types) zip.file("[Content_Types].xml", types);
    if (settings) zip.file("word/settings.xml", settings);
  };
  put();
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gongwen-fix-")), "mid.docx");
  fs.writeFileSync(tmp, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const left = await remaining(tmp);
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });

  const cm = addComments(docXml, toComments(left.items), { existing: existingComments, startId: next, author: AUTHOR, date });
  docXml = cm.xml;
  ({ rels, types } = registerComments(rels, types));
  zip.file("word/comments.xml", cm.comments);
  put();
  fs.writeFileSync(o.out, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));

  // 报告
  const nEdits = Object.values(tally).reduce((a, b) => a + b, 0);
  console.log(`修复完成　${path.basename(o.out)}（原文件未改动）`);
  if (o.layout) {
    console.log("  版式（直接改）：");
    notes.forEach((n) => console.log("    · " + n));
  }
  console.log(`  体例（修订痕迹，${nEdits} 处，在 Word「审阅」里逐条接受或拒绝）：`);
  Object.entries(tally).forEach(([k, v]) => console.log(`    · ${k} ${v} 处`));
  if (tp.skipped) console.log(`    · 另有 ${tp.skipped} 处碰到域、超链接或已有修订，没有自动改，已转批注`);
  console.log(`  批注 ${cm.placed + cm.unplaced} 条（数字与改法要靠判断的项，不自动改）${cm.unplaced ? `，其中 ${cm.unplaced} 条没定位到原文、挂在首段` : ""}`);
  const byKind = {};
  left.items.forEach((it) => { byKind[it.kind] = (byKind[it.kind] || 0) + 1; });
  Object.entries(byKind).forEach(([k, v]) => console.log(`    · ${k} ${v} 项`));
  if (left.style.length) {
    console.log("  文风风格层（只提示，没插批注，看语境定）：");
    left.style.forEach((l) => console.log("    · " + l));
  }
})().catch((e) => {
  console.error("修复失败（工具故障，原文件未改动）：", e.message);
  process.exit(2);
});
