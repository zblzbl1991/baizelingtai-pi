#!/usr/bin/env node
/**
 * qiye.js —— 非红头样张（企业内部报告）：央国企日常最常用的形态。
 *
 * 用法：node templates/qiye.js [输出路径]
 *
 * 不带版头：没有发文机关标志、发文字号和红色分隔线，从标题直接起；
 * 主送、正文、层次序数、表格、落款、附注与红头公文相同，版心照样按 GB/T 9704。
 * 子公司向集团报送、部门向公司领导报告、内部工作方案多是这个样子。
 * 表格合计与正文「三个方面」都经数字机检核对。
 */
"use strict";
const G = require("../lib/gongwen-core").form("wen");
const { Document } = G.require_docx();
const {
  externalStyles, numbering, sectionProps, writeDoc,
  title, zhusong, p, h1, h2, table, luokuan, fuzhu, AlignmentType,
} = G;

const out = process.argv[2] || require("path").join(__dirname, "../samples/word/企业内部报告.docx");

const doc = new Document({
  creator: "gongwen-kit",
  title: "关于 2026 年三季度安全生产工作情况的报告",
  features: { updateFields: true },
  evenAndOddHeaderAndFooters: true,
  externalStyles: externalStyles(),
  numbering,
  sections: [{
    ...sectionProps(),
    children: [
      ...title(["××建设有限公司", "关于 2026 年三季度安全生产工作情况的报告"]),
      zhusong("××集团有限公司"),
      p("现将我公司 2026 年三季度安全生产工作情况报告如下（本件为格式示范，单位与数字均为虚构）。"),
      h1("主要工作"),
      p("三季度主要做了三个方面的工作。"),
      h2("隐患排查"),
      p("组织在建项目开展隐患排查，覆盖全部 12 个在建项目，整改闭环情况见表 1。"),
      h2("教育培训"),
      p("开展全员安全教育培训，新进场人员实行先培训、后上岗。"),
      h2("应急演练"),
      p("各项目部结合汛期特点开展防汛、防坍塌专项应急演练。"),
      ...table({
        caption: "表 1　三季度隐患排查整改情况",
        widths: [2844, 2000, 2000, 2000],
        head: ["隐患类别", "排查（项）", "已整改（项）", "整改中（项）"],
        rows: [
          ["高处作业", "46", "44", "2"],
          ["临时用电", "38", "38", "0"],
          ["起重吊装", "21", "19", "2"],
          ["基坑支护", "15", "14", "1"],
          ["合计", "120", "115", "5"],
        ],
        align: [AlignmentType.LEFT, AlignmentType.CENTER, AlignmentType.CENTER, AlignmentType.CENTER],
      }),
      h1("存在的问题"),
      p("个别分包单位现场管理人员配备不足，起重吊装作业旁站监护不到位。"),
      h1("下一步安排"),
      p("四季度重点抓好冬季施工和岁末年初安全管理，整改中的 5 项隐患于 11 月底前全部闭环。"),
      p("特此报告。"),
      ...luokuan({ unit: "××建设有限公司", date: "2026 年 10 月 12 日" }),
      fuzhu("（联系人：×××，联系电话：×××-××××××××。）"),
    ],
  }],
});

writeDoc(doc, out);
