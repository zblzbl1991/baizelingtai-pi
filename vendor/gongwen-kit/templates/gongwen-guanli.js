#!/usr/bin/env node
/**
 * gongwen-guanli.js —— 对外·行文档样张（条文体）
 *
 * 用法：node templates/gongwen-guanli.js [输出路径]
 *
 * 管理办法、工作条例这一类，层次是「第X章／第X条／（一）／1.」，跟行文体的
 * 「一、／（一）／1.／（1）」是两套编号。体式在第一行声明，往后 h1～h4 自带
 * 对应形式，拿不错。版心、行字数、页码与行文体共用，都是 GB/T 9704 的硬指标。
 *
 * 条文体没有主送机关，也不写「妥否，请批示」。落款是制定机关与施行日期。
 */
"use strict";
const G = require("../lib/gongwen-core").form("zhang");
const { Document } = G.require_docx();
const {
  externalStyles, numbering, sectionProps, writeDoc,
  title, p, flush, h1, h2, h3, h4, luokuan,
} = G;

const out = process.argv[2] || require("path").join(__dirname, "../samples/word/公文管理办法.docx");

const doc = new Document({
  creator: "gongwen-kit",
  title: "示例事项管理办法",
  features: { updateFields: true },
  evenAndOddHeaderAndFooters: true,
  externalStyles: externalStyles(),
  numbering,
  sections: [{
    ...sectionProps(),
    children: [
      ...title(["示例事项管理办法"]),

      h1("总则"),
      h2("为规范示例事项的办理，明确各方职责，依据有关规定，制定本办法。"),
      h2("本办法适用于示例事项的申请、审核、实施与检查。"),
      h2("办理示例事项应当遵循下列原则："),
      h3("依法依规，程序完备"),
      h3("权责一致，各负其责"),
      h3("公开透明，接受监督"),

      h1("职责分工"),
      h2("牵头部门负责统筹协调、组织实施与督促检查，具体职责如下："),
      h3("拟订年度工作计划并组织实施"),
      h3("受理申请、组织审核并出具意见"),
      h2("配合部门按照职责分工承办相关事项，在规定时限内反馈意见。"),

      h1("办理程序"),
      h2("申请人应当提交下列材料："),
      h3("申请书"),
      h3("主体资格证明"),
      h3("其他依法应当提交的材料"),
      h2("牵头部门自收到完整材料之日起 10 个工作日内完成审核，"
        + "情况复杂的可以延长 5 个工作日，并告知申请人。"),
      h2("审核通过的，出具书面意见；不予通过的，说明理由并告知申请人。"),

      h1("台账管理"),
      h2("牵头部门应当建立审核台账，如实记录下列事项："),
      h3("申请与受理情况"),
      h4("申请人名称、申请日期与材料接收情况"),
      h4("补正材料的发出与接收时间"),
      h3("审核过程与结论"),
      h2("台账保存期限不少于五年。"),

      h1("监督与责任"),
      h2("牵头部门应当建立台账，如实记录办理情况，接受监督检查。"),
      h2("违反本办法规定的，按照有关规定处理；构成犯罪的，依法追究刑事责任。"),

      h1("附则"),
      h2("本办法由牵头部门负责解释。"),
      h2("本办法自发布之日起施行。"),

      // 无公章形态（GB/T 9704 7.3.5.2）：署名右空二字、日期首字比署名首字右移二字
      ...luokuan({ unit: "××单位", date: "2026 年 9 月 10 日", sealed: false }),
    ],
  }],
});

writeDoc(doc, out);
