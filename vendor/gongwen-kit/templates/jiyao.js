#!/usr/bin/env node
/**
 * jiyao.js —— 纪要格式样张（GB/T 9704 10.3）：会议纪要。
 *
 * 用法：node templates/jiyao.js [输出路径]
 *
 * 纪要标志「×××纪要」居中、红色、上边缘距版心 35mm；期号与红色分隔线沿用版头构件。
 * 正文后空一行排出席、请假、列席名单：标签黑体、名单仿宋、回行与冒号后首字对齐。
 * 国标注明「纪要格式可以根据实际制定」，期号与分隔线是常见做法，不是硬性条款。
 */
"use strict";
const G = require("../lib/gongwen-core").form("wen");
const { Document } = G.require_docx();
const {
  externalStyles, numbering, sectionProps, writeDoc,
  jiyaoHead, title, p, h1, attendees, banji,
} = G;

const out = process.argv[2] || require("path").join(__dirname, "../samples/word/公文纪要.docx");

const doc = new Document({
  creator: "gongwen-kit",
  title: "××市人民政府常务会议纪要",
  features: { updateFields: true },
  evenAndOddHeaderAndFooters: true,
  externalStyles: externalStyles(),
  numbering,
  sections: [{
    ...sectionProps(),
    children: [
      ...jiyaoHead({ mark: "××市人民政府常务会议纪要", issue: "〔2026〕第 18 期" }),
      ...title("××市人民政府第 18 次常务会议纪要"),
      p("2026 年 10 月 12 日，市长×××主持召开市人民政府第 18 次常务会议，"
        + "研究公文格式规范培训、年度督查工作等事项。纪要如下。"),
      h1("关于公文格式规范培训工作"),
      p("会议听取了市政府办公室关于公文格式规范培训工作的汇报，原则同意培训方案。"
        + "会议要求做好以下两项工作：一是 11 月底前完成市直部门培训，二是将格式差错纳入年度督查。"),
      h1("关于年度督查工作"),
      p("会议原则同意年度督查工作安排，由市政府督查室会同有关部门组织实施。"),
      ...attendees([
        ["出席", "×××、×××、×××、×××、×××、×××、×××、×××、×××、×××、×××、×××"],
        ["请假", "×××"],
        ["列席", "市政府办公室、市财政局、市档案馆负责同志"],
      ]),
      ...banji({
        copyTo: ["市委办公室", "市人大常委会办公室", "市政协办公室"],
        issuer: "××市人民政府办公室",
        date: "2026 年 10 月 13 日",
      }),
    ],
  }],
});

writeDoc(doc, out);
