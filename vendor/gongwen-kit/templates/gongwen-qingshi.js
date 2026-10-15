#!/usr/bin/env node
/**
 * gongwen-qingshi.js —— 上行文样张（请示）：带完整版头与签发人。
 *
 * 用法：node templates/gongwen-qingshi.js [输出路径]
 *
 * 上行文的核心区别：
 *   发文字号居左空一字，与最后一个签发人姓名同行；
 *   签发人居右空一字，「签发人：」用仿宋、姓名用楷体，每行两个姓名、
 *   回行与上一行第一个姓名对齐（本件三名签发人，示范回行）。
 * 其余要素（标题、主送、正文、四层层次序数、表格、附件说明、落款、附注）
 * 与下行文相同；联合行文的机关标志形态见 complete.js。
 */
"use strict";
const G = require("../lib/gongwen-core").form("wen");
const { Document } = G.require_docx();
const {
  externalStyles, numbering, sectionProps, writeDoc,
  letterhead, title, zhusong, p, h1, h2, h3, h4, table,
  luokuan, fujian, fuzhu, fujianPage, AlignmentType,
} = G;

const out = process.argv[2] || require("path").join(__dirname, "../samples/word/公文请示.docx");

const doc = new Document({
  creator: "gongwen-kit",
  title: "关于示例事项的请示",
  features: { updateFields: true },
  evenAndOddHeaderAndFooters: true,
  externalStyles: externalStyles(),
  numbering,
  sections: [{
    ...sectionProps(),
    children: [
      ...letterhead({
        copyNo: "000001",
        secret: "秘密★1年",
        agency: "××市人民政府",
        docNo: { dept: "×政发", year: 2026, seq: 8 },
        signers: ["张××", "李××", "王××"],
      }),
      ...title(["关于示例事项的请示"]),
      zhusong("××省人民政府"),
      p("为说明上行文的体例，现将请示文种的各要素、层次序数与表格写法列示如下，"
        + "供核对格式使用。本件不涉及任何实际事项。"),
      h1("签发人"),
      p("上报的公文应当标注签发人姓名：发文字号居左空一字，与最后一个签发人姓名同行；"
        + "签发人居右空一字，每行两个姓名，回行与上一行第一个姓名对齐。"),
      h1("层次序数"),
      p("层次序数共四层，依次为「一、」「（一）」「1.」「（1）」；第一层用黑体，"
        + "第二层用楷体，第三、四层用仿宋。四层之外不再分层。"),
      h2("第二层示范"),
      p("第二层标题下为正文，仍为仿宋三号、首行缩进二字。"),
      h3("第三层示范"),
      p("第三层标题下为正文。"),
      h4("第四层示范"),
      p("第四层标题下为正文；再往下不再分层，确需再分的改写正文。"),
      h1("版式"),
      p("版心为上 37、下 35、左 28、右 26 毫米，每页 22 行、每行 28 字；"
        + "发文机关标志上边缘距版心上边缘 35 毫米，红色分隔线在发文字号之下 4 毫米。"),
      ...table({
        caption: "表 1　版式指标",
        widths: [2400, 2400, 2400],
        head: ["项目", "规定值", "依据"],
        rows: [
          ["上边距", "37 毫米", "GB/T 9704 8.1"],
          ["下边距", "35 毫米", "GB/T 9704 8.1"],
          ["每页行数", "22 行", "GB/T 9704 8.1"],
          ["每行字数", "28 字", "GB/T 9704 8.1"],
        ],
        align: [AlignmentType.LEFT, AlignmentType.CENTER, AlignmentType.LEFT],
      }),
      h1("请示事项"),
      p("以上事项，妥否，请批示。"),
      ...fujian("版式指标对照表"),
      ...luokuan({ unit: "××市人民政府", date: "2026 年 10 月 12 日" }),
      fuzhu("（联系人：×××，联系电话：×××-××××××××。）"),
      ...fujianPage({
        title: "版式指标对照表",
        body: [p("只有一个附件时不编顺序号，只写「附件」二字。本页为附件页格式示范。")],
      }),
    ],
  }],
});

writeDoc(doc, out);
