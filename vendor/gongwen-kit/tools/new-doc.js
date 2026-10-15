#!/usr/bin/env node
/**
 * new-doc.js —— 起一份稿源脚本骨架。
 *
 * 用法：node tools/new-doc.js --form wen|zhang --out <路径.js> [--title "标题"]
 *
 * 骨架里的 require 路径在生成时写死为本仓的绝对路径（稿源放在仓库之外时，
 * 各自的 require 解析不到本仓的 docx 模块，会出坏文件）；仓库挪位置就改那一行。
 * 写法照 templates/ 里的样张，不照别的项目的旧脚本抄——旧写法会一份传一份。
 */
"use strict";
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const form = get("--form", "wen");
const out = get("--out");
const title = get("--title", form === "zhang" ? "××管理办法" : "关于××事项的通知");
if (!out || !["wen", "zhang"].includes(form)) {
  console.error("用法：node tools/new-doc.js --form wen|zhang --out <路径.js> [--title \"标题\"]");
  process.exit(2);
}

const REPO = path.dirname(__dirname);
const body = form === "wen" ? `      // 版头：上行文（请示/上报的报告）加 signers；预印套打加 preprinted: true
      // ...letterhead({
      //   agency: "××机关", docNo: { dept: "×发", year: 2026, seq: 1 },
      // }),
      ...title(["${title}"]),          // 长标题按意群分两行：title(["上行", "下行"])
      zhusong("××单位"),
      p("正文第一段。首行缩进两字由样式给，不要自己加空格。"),
      h1("一级标题"),
      p("正文。"),
      ...luokuan({ unit: "××机关", date: "2026 年 10 月 12 日" }),
      // 需要版记时接：...banji({ copyTo: ["××部门"], issuer: "××机关", date: "2026 年 10 月 12 日" }),`
  : `      ...title(["${title}"]),
      h1("总则"),
      h2("为规范××事项，制定本办法。"),
      h1("附则"),
      h2("本办法自发布之日起施行。"),
      ...luokuan({ unit: "××机关", date: "2026 年 10 月 12 日" }),`;

const content = `#!/usr/bin/env node
// gongwen-kit 稿源骨架（${form === "wen" ? "行文体" : "条文体"}）。写完正文直接运行，机检自动跑。
"use strict";
const G = require(${JSON.stringify(REPO + "/lib/gongwen-core")}).form("${form}");
// 上面这行是生成时写死的仓路径；仓库挪位置或稿源在别处 require 不到 docx 时改它。
const { Document } = G.require_docx();
const {
  externalStyles, numbering, sectionProps, writeDoc,
  letterhead, title, zhusong, p, h1, h2, luokuan, banji,
} = G;

const out = process.argv[2] || require("path").join(__dirname, ${JSON.stringify(path.basename(out).replace(/\.js$/, "") + ".docx")});

const doc = new Document({
  creator: "",
  features: { updateFields: true },
  evenAndOddHeaderAndFooters: true,
  externalStyles: externalStyles(),
  numbering,
  sections: [{
    ...sectionProps(),
    children: [
${body}
    ],
  }],
});

writeDoc(doc, out);
`;

fs.writeFileSync(out, content);
console.log("→", out, "（写完正文出稿：node " + out + "）");
