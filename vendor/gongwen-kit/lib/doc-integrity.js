"use strict";
/**
 * doc-integrity.js —— 出稿流程的两层结构检查（2026-09-23 立，2026-10-12 抽出）。
 *
 * 为什么排在所有机检之前：稿源把 `ul([...])` 这类返回数组的构件直接放进
 * section children、漏了 `...`，docx 会把它序列化成 `<0/>`。按文本抽取的
 * 机检（体例、数字、文风）全部放行；结果 Word 打不开，导出 PDF 超时或失败。
 * 所以先过两层结构检查：
 *
 *   (a) 打包前 assertDocTree：逐节逐个子元素递归查，遇到数组或非 docx 元素
 *       就抛，报出 sections[i].children[j]，提示是不是漏了 `...`。
 *   (b) 写盘后 checkXmlParts：zip 里每个 XML 部件都用严格解析器过一遍，
 *       不 well-formed 就报部件名与行列、退出码非零，不再往下跑别的机检。
 *
 * (a) 拦已知的形状，(b) 兜住 (a) 没想到的形状——哪一层漏了，另一层还在。
 */

// docx 元素的判据：有 prepForXml（Formatter 序列化就靠它）。不用 instanceof，
// 免得两份 docx 模块并存时误报。
const isDocxEl = (x) => x != null && typeof x === "object" && !Array.isArray(x)
  && typeof x.prepForXml === "function";
// 节分隔段：Body.addSection 在每节末尾塞一个 pPr 里挂 sectPr 的空段落。
const isSectBreak = (x) => isDocxEl(x) && Array.isArray(x.root) && x.root.some((c) =>
  c && Array.isArray(c.root) && c.root.some((g) => g && g.rootKey === "w:sectPr"));
const describe = (x) => Array.isArray(x) ? `数组（${x.length} 项）`
  : x === null ? "null" : typeof x === "object" ? `对象 ${x.constructor ? x.constructor.name : "Object"}`
  : x === undefined ? "undefined" : `${typeof x} ${String(JSON.stringify(x)).slice(0, 40)}`;

function assertDocTree(doc) {
  const bodyEl = doc && doc.documentWrapper && doc.documentWrapper.document && doc.documentWrapper.document.body;
  const root = bodyEl && bodyEl.root;
  if (!Array.isArray(root) || !Array.isArray(bodyEl.sections)) throw new Error("writeDoc：取不到 Document 的 body 结构（传进来的不是 docx Document，或 docx 升级改了内部结构）");
  const bad = [];
  const walk = (el, path) => {
    if (!Array.isArray(el.root)) return;   // 属性组件的 root 是对象，不下钻
    el.root.forEach((c, k) => {
      const p = `${path} → ${el.constructor.name}[${k}]`;
      if (typeof c === "string" || typeof c === "number") return;   // w:t 的文本
      if (!isDocxEl(c)) { bad.push([p, c]); return; }
      walk(c, p);
    });
  };
  // body.root 按节平铺：[占位段, 第 0 节的子元素…, 分隔段, 第 1 节…]，末节没有尾随分隔段。
  // 占位段是 addSection 第一次调用时给「前一节」（不存在）建的，pPr 里是 undefined，
  // 打包时 Body.prepForXml 把它删掉——那时 sections 才从 1 变 0。没打包过就跳过它。
  let sec = 0, j = 0;
  for (const c of root.slice(bodyEl.sections.length === 1 ? 1 : 0)) {
    if (isSectBreak(c)) { sec++; j = 0; continue; }
    const path = `sections[${sec}].children[${j++}]`;
    if (!isDocxEl(c)) bad.push([path, c]);
    else walk(c, path);
  }
  if (bad.length) {
    const lines = bad.slice(0, 10).map(([p, c]) => `  ${p}：${describe(c)}`
      + (Array.isArray(c) ? "——forgot ... spread?（ul/ol 这类返回数组的构件要写 ...ul([...])）" : ""));
    throw new Error(`writeDoc：文档树里有 ${bad.length} 处不是 docx 元素，打包出来 Word 打不开：\n${lines.join("\n")}`
      + (bad.length > 10 ? `\n  ……另有 ${bad.length - 10} 处` : ""));
  }
}

// 逐个 XML 部件做 well-formed 检查。返回问题清单，空数组＝全部通过。
async function checkXmlParts(buf) {
  const JSZip = require("jszip");
  const sax = require("sax");
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && /\.(xml|rels)$/i.test(n)).sort();
  const problems = [];
  for (const name of names) {
    const xml = await zip.files[name].async("string");
    const parser = sax.parser(true);
    // 只记第一处：位置要在出错当下取，解析器继续往下走位置就变了。
    let err = null;
    parser.onerror = (e) => {
      if (!err) err = { message: e.message, line: parser.line, column: parser.column, position: parser.position };
      throw e;
    };
    try { parser.write(xml).close(); } catch (e) { if (!err) err = { message: e.message, line: parser.line, column: parser.column, position: parser.position }; }
    if (err) {
      const at = `第 ${err.line + 1} 行第 ${err.column} 列（字符偏移 ${err.position}）`;
      const near = xml.slice(Math.max(0, err.position - 60), err.position + 20).replace(/\s+/g, " ");
      problems.push({ part: name, at, message: String(err.message).split("\n")[0], near });
    }
  }
  return problems;
}

module.exports = { assertDocTree, checkXmlParts };
