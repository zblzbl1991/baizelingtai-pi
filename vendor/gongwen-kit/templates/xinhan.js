#!/usr/bin/env node
/**
 * xinhan.js —— 信函格式样张（GB/T 9704 10.1）：平行机关之间的函。
 *
 * 用法：node templates/xinhan.js [输出路径]
 *
 * 首页：发文机关标志（不加「文件」）、上粗下细与上细下粗两条红色双线、
 * 份号与密级（左）、发文字号（右），首页不印页码。版记只留抄送。
 */
"use strict";
const G = require("../lib/gongwen-core").form("wen");
const { Document } = G.require_docx();
const {
  externalStyles, numbering, writeDoc, xinhanSection, xinhanHead,
  title, zhusong, p, h1, luokuan, banji,
} = G;

const out = process.argv[2] || require("path").join(__dirname, "../samples/word/公文信函.docx");

const doc = new Document({
  creator: "gongwen-kit",
  title: "××市人民政府办公室关于商请协助开展公文格式规范培训的函",
  features: { updateFields: true },
  evenAndOddHeaderAndFooters: true,
  externalStyles: externalStyles(),
  numbering,
  sections: [{
    ...xinhanSection({ agency: "××市人民政府办公室" }),
    children: [
      ...xinhanHead({
        copyNo: "000001",
        secret: "秘密★1年",
        docNo: { dept: "×政办函", year: 2026, seq: 35 },
      }),
      ...title(["××市人民政府办公室关于商请协助开展", "公文格式规范培训的函"]),
      zhusong("××市档案馆"),
      p("为提高全市行政机关办文质量，我办拟于 2026 年 11 月组织开展公文格式规范培训。"
        + "贵馆在公文归档与格式审核方面经验丰富，现商请贵馆协助做好以下工作。"),
      h1("选派授课人员"),
      p("请选派 1 名熟悉公文归档要求的同志，围绕公文格式与归档规范授课，时长约 2 小时。"),
      h1("提供教学案例"),
      p("请提供近年归档审核中发现的常见格式差错案例 10 至 15 个，隐去单位名称与文号。"),
      h1("时间安排"),
      p("培训具体时间、地点另行商定。请于 2026 年 10 月 25 日前将授课人员名单函告我办文书科。"),
      p("联系人：×××，联系电话：×××-××××××××。"),
      p("特此函商，请予支持。"),
      ...luokuan({ unit: "××市人民政府办公室", date: "2026 年 10 月 13 日" }),
      ...banji({ letter: true, copyTo: ["市委办公室"] }),
    ],
  }],
});

writeDoc(doc, out);
