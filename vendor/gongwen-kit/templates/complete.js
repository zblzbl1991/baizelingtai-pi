#!/usr/bin/env node
/**
 * complete.js —— 要素全览（样式展示）：一份把所有构件与格式都摆出来的样张。
 *
 * 用法：node templates/complete.js [输出路径]
 *
 * 展示面：
 *   版头    份号、密级和保密期限、紧急程度、发文机关标志（联合行文形态）、
 *           发文字号、红色分隔线
 *   主体    标题、主送机关、正文、四层层次序数（h1～h4 各一）、三线表、
 *           附件说明（多个附件）、署名与成文日期（联合署名）、附注
 *   版记    抄送机关、印发机关和印发日期、三条分隔线
 *   页码    单双页分设（自动）
 * 上行文的签发人形态见 gongwen-qingshi.js；标题两行回行的形态见 notice.js；
 * 套打模式（preprinted）印出来是留白的，只能靠文档说明，见 letterhead 注释。
 */
"use strict";
const G = require("../lib/gongwen-core").form("wen");
const { Document } = G.require_docx();
const {
  externalStyles, numbering, sectionProps, writeDoc,
  letterhead, title, zhusong, p, h1, h2, h3, h4, table,
  luokuan, fujian, fuzhu, fujianPage, banji, AlignmentType,
} = G;

const out = process.argv[2] || require("path").join(__dirname, "../samples/word/公文要素全览.docx");

const doc = new Document({
  creator: "gongwen-kit",
  title: "关于发布公文要素示范文本的通知",
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
        agency: ["××市人民政府", "××市发展和改革委员会"],
        docNo: { dept: "×政发", year: 2026, seq: 12 },
      }),
      ...title(["关于发布公文要素示范文本的通知"]),
      zhusong("各县（市、区）人民政府，市政府各部门"),
      p("为便于规范使用公文格式，现将公文各要素的示范样式印发如下。本件为格式示范，"
        + "不涉实际事项；各要素按顺序列示。"),
      h1("版头要素"),
      p("版头包含份号、密级和保密期限、紧急程度、发文机关标志、发文字号与红色分隔线；"
        + "上行文另加签发人，形态见请示样张。"),
      h2("发文机关标志"),
      p("联合行文时，主办机关名称排列在前，机关名称逐行居中，「文件」二字置于名称右侧、"
        + "以联署名称为准上下居中；上边缘距版心上边缘 35 毫米。"),
      h2("发文字号"),
      p("由机关代字、年份、发文顺序号组成：年份用六角括号〔〕括入，顺序号不编虚位、"
        + "不加「第」字，数字后加「号」字。"),
      h1("主体要素"),
      h2("标题"),
      p("二号小标宋体字，回行时按意群断开、排列对称（两行回行的形态见通知样张）。"),
      h2("层次序数"),
      p("共四层：第一层黑体、第二层楷体、第三、四层仿宋。以下逐层示范。"),
      h3("第三层为阿拉伯数字加下脚点"),
      p("第三层标题下为正文，仍为仿宋三号、首行缩进二字。"),
      h4("第四层为阿拉伯数字加圆括号"),
      p("第四层标题下为正文；再往下不再分层，确需再分的改写正文。"),
      h1("表格与附件"),
      h2("三线表"),
      p("数据表的表题在表上方居中，表内不加句末标点，空单元格写一字线。"),
      ...table({
        caption: "表 1　版式硬指标",
        widths: [2600, 2600, 2600],
        head: ["项目", "规定值", "依据"],
        rows: [
          ["版心", "上 37 下 35 左 28 右 26 毫米", "GB/T 9704 8.1"],
          ["行字数", "每页 22 行、每行 28 字", "GB/T 9704 8.1"],
          ["发文机关标志上缘", "距版心上边缘 35 毫米", "GB/T 9704 7.2.4"],
        ],
        align: [AlignmentType.LEFT, AlignmentType.CENTER, AlignmentType.LEFT],
      }),
      h2("附件说明"),
      p("多于一个附件时，用阿拉伯数字标注顺序号，其余各行与第一行附件名称首字对齐，"
        + "名称后不加标点。"),
      ...fujian(["公文要素示范文本（一）", "公文要素示范文本（二）"]),
      p("以上样式供参照使用。"),
      ...luokuan({
        unit: ["××市人民政府", "××市发展和改革委员会"],
        date: "2026 年 10 月 12 日",
      }),
      fuzhu("（联系人：×××，联系电话：×××-××××××××。）"),
      ...fujianPage({
        n: 1,
        title: "公文要素示范文本（一）",
        body: [
          p("附件另面编排，标题居中在版心第三行，用三号小标宋；其余格式与主件相同。"),
          h1("附件的层次"),
          p("附件内可以使用主件的全部构件：层次序数、表格、附注等。"),
        ],
      }),
      ...fujianPage({
        n: 2,
        title: "公文要素示范文本（二）",
        body: [p("多个附件各占自己的附件页；顺序号与正文附件说明的表述一致。")],
      }),
      ...banji({
        copyTo: ["市委各部门", "市人大常委会办公室"],
        issuer: "××市人民政府办公室",
        date: "2026 年 10 月 12 日",
      }),
    ],
  }],
});

writeDoc(doc, out);
