#!/usr/bin/env node
/**
 * notice.js —— 下行文样张：带完整版头的通知。
 *
 * 用法：node templates/notice.js [输出路径]
 *
 * 版头要素齐全（份号、密级和保密期限、紧急程度、发文机关标志、发文字号、
 * 红色分隔线），落款按加盖印章的常见排法（右空四字）。版记构件（抄送、
 * 印发机关与日期）定版后补进本样张。
 */
"use strict";
const G = require("../lib/gongwen-core").form("wen");
const { Document } = G.require_docx();
const {
  externalStyles, numbering, sectionProps, writeDoc,
  letterhead, title, zhusong, p, h1, luokuan, fuzhu, banji,
} = G;

const out = process.argv[2] || require("path").join(__dirname, "../samples/word/公文通知.docx");

const doc = new Document({
  creator: "gongwen-kit",
  title: "××市人民政府办公室关于开展行政机关公文格式规范培训工作的通知",
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
        urgency: "特急",
        agency: "××市人民政府办公室",
        docNo: { dept: "×政办发", year: 2026, seq: 12 },
      }),
      ...title(["××市人民政府办公室关于开展行政机关", "公文格式规范培训工作的通知"]),
      zhusong("各县（市、区）人民政府，市政府各部门"),
      p("为规范公文格式，提高办文质量，现就开展行政机关公文格式规范培训有关事项通知如下。"),
      h1("培训内容"),
      p("公文版心与行字数、标题与正文用字、层次序数、附件说明、成文日期与"
        + "页脚页码等要素的编排规则，以及常见格式差错案例。"),
      h1("参训人员"),
      p("各县（市、区）人民政府、市政府各部门负责公文处理工作的同志，每单位 1 至 2 人。"),
      h1("有关要求"),
      p("各单位于 2026 年 10 月 20 日前将参训人员名单报送市政府办公室文书科；"
        + "培训具体时间、地点另行通知。"),
      p("联系人：×××，联系电话：×××-××××××××。"),
      ...luokuan({ unit: "××市人民政府办公室", date: "2026 年 10 月 12 日" }),
      fuzhu("（此件公开发布）"),
      ...banji({
        copyTo: ["市委各部门", "市人大常委会办公室", "市政协办公室"],
        issuer: "××市人民政府办公室",
        date: "2026 年 10 月 12 日",
      }),
    ],
  }],
});

writeDoc(doc, out);
