"use strict";
/**
 * letterhead.js —— 版头构件（GB/T 9704 7.2）。
 *
 * 要素与规则（条款逐条对照过扫描件）：
 *   份号        6 位阿拉伯数字，版心左上角第一行（7.2.1）
 *   密级和保密期限  3 号黑体，左上角第二行（7.2.2）
 *   紧急程度     3 号黑体，左上角第三行（7.2.3）
 *   发文机关标志  全称/简称加「文件」二字，居中，上边缘至版心上边缘 35mm，
 *              小标宋体字，红色（7.2.4）；联合行文时主办机关在前，「文件」
 *              置右侧、以联署名称为准上下居中
 *   发文字号     标志下空二行，居中；年份用六角括号、顺序号不编虚位；
 *              上行文居左空一字、与最后一个签发人姓名同行（7.2.5）
 *   签发人       「签发人：」3 号仿宋、姓名 3 号楷体，居右空一字；
 *              多个每行两个、回行与上一行第一个姓名对齐（7.2.6）
 *   红色分隔线    发文字号之下 4mm，与版心等宽（7.2.7）
 *
 * 位置控制：整段用显式行高（lineRule: exact）的空段落补间距。35mm 与 4mm
 * 是硬指标，靠渲染量测校准：改下面的常数前先跑 tools/measure-letterhead.py
 * 量一遍，改完重量，别凭印象调。
 */
const {
  Paragraph, TextRun, Tab, AlignmentType, BorderStyle, VerticalAlign,
  Table, TableRow, TableCell, WidthType, TableLayoutType,
} = require("docx");

// ── 版式常数（twips）──────────────────────────────────────
const BODY_LINE = 579;            // 正文行高（docGrid linePitch），「空二行」用它量
const GAP_2LINES = BODY_LINE * 2; // 标志下空二行、分隔线下空二行
const MARK_TOP = 1984;            // 35mm：标志上边缘至版心上边缘
const RED_GAP = 153;              // 发文字号字形框底至红线（量测校准，见下）
const CONTENT_W = 8844;           // 版心宽 156mm（tab 位基准）
const ONE_CHAR = 316;             // 三号字一个字宽（右空/左空一字用）
const RED = "FF0000";

// 量测校准值（2026-10-12，tools/measure-letterhead.py 反推）：
// MARK_GLYPH_PAD 是标志字形框上缘在它那一行内的顶部留白；RED_GAP 让红线
// 落在发文字号字形框底之下 4mm。改版头行高或字号后必须重新量。
const MARK_SIZE_PT = 36;          // 小初；国标说「以醒目、美观、庄重为原则酌定」
const MARK_LINE = 1080;           // 标志行的显式行高
const MARK_GLYPH_PAD = 99;
const MARK_SINK_TW_PER_PT = 20.4;   // 字号每小 1pt，字形在标志行里下沉的 twips（量测校准）
// 联合行文的标志表格比单段标志高出约 0.69mm，与字号无关（26／30／36pt 量测：
// 34.42／34.33／34.29mm）：表格前的空段补长
const JOINT_PAD = 39;
const MIN_BLANK = 100;            // exact 行高低于这个数的空段 Word 不认（docs/版式.md 坑 12）

const run = (text, { font, size, color } = {}) => new TextRun({
  text: String(text),
  font: font ? { eastAsia: font, ascii: font, hAnsi: font } : undefined,
  size, color,
});
const zero = { firstLine: 0, firstLineChars: 0 };
const blank = (h) => new Paragraph({
  indent: zero, spacing: { line: h, lineRule: "exact" }, children: [],
});

function formatDocNo(d) {
  if (typeof d === "string") return d;
  if (!d || !d.dept || !d.year || !d.seq) {
    throw new Error("发文字号要 { dept, year, seq } 或字符串，给的是：" + JSON.stringify(d));
  }
  return `${d.dept}〔${d.year}〕${d.seq}号`;
}

/** 单个机关的标志段。 */
function markParagraph(text, { markFont, markSizePt }, before = 0) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    indent: zero,
    spacing: { line: MARK_LINE, lineRule: "exact", ...(before > 0 ? { before } : {}) },
    children: [run(text, { font: markFont, size: markSizePt * 2, color: RED })],
  });
}

/** 联合行文标志：机关名逐行居中成一列，「文件」在右侧上下居中（图 3／4 的形态）。
 *  列宽写死（版心宽减去「文件」两字宽），不让 Word 自动分配把「文件」挤成竖排。 */
function markTable(agencies, withFile, { markFont, markSizePt }) {
  const NONE = { style: BorderStyle.NONE, size: 0, color: "auto" };
  const fileW = withFile ? markSizePt * 40 : 0;   // 「文件」两字的宽度
  const namesW = CONTENT_W - fileW;
  const line = (t) => new Paragraph({
    alignment: AlignmentType.CENTER,
    indent: zero,
    spacing: { line: Math.round(MARK_LINE * 0.95), lineRule: "exact" },
    children: [run(t, { font: markFont, size: markSizePt * 2, color: RED })],
  });
  const cell = (w, children) => new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    width: { size: w, type: WidthType.DXA },
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    children,
  });
  const cells = [cell(namesW, agencies.map(line))];
  if (withFile) cells.push(cell(fileW, [line("文件")]));
  return new Table({
    alignment: AlignmentType.CENTER,
    width: { size: CONTENT_W, type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE },
    rows: [new TableRow({ children: cells })],
  });
}

/** 版头。返回段落序列，直接摊进 section children（或 templates 的 children）。 */
function letterhead(opts = {}) {
  const o = {
    withFile: true,
    preprinted: false,
    markSizePt: MARK_SIZE_PT,
    markFont: "Songti SC Black",
    ...opts,
  };
  if (!o.agency) throw new Error("版头要有发文机关标志：agency 字符串或字符串数组");
  const out = [];

  // 1 左上角：份号 / 密级和保密期限 / 紧急程度，按序自上而下
  const fields = [];
  if (o.copyNo != null) fields.push(String(o.copyNo).padStart(6, "0"));
  if (o.secret) fields.push(o.secret);
  if (o.urgency) fields.push(o.urgency);
  for (const t of fields) {
    out.push(new Paragraph({
      indent: zero,
      spacing: { line: BODY_LINE, lineRule: "exact" },
      children: [run(t, { font: "SimHei", size: 32 })],
    }));
  }

  // 2 发文机关标志字号。机关名过长时按 2pt 步降字号（下限 22pt/二号），
  // 别让「文件」或机关名回行。
  const agencies = Array.isArray(o.agency) ? o.agency : [o.agency];
  const longest = Math.max(...agencies.map((a) => [...String(a)].length)) + (o.withFile ? 2 : 0);
  let markSizePt = o.markSizePt;
  while (markSizePt > 22 && longest * markSizePt * 20 > CONTENT_W) markSizePt -= 2;
  if (!o.preprinted && longest * markSizePt * 20 > CONTENT_W) {
    throw new Error(`发文机关标志 ${longest} 字，降到二号仍超出版心宽、会回行被裁掉；改用规范化简称`);
  }
  const mo = { ...o, markSizePt };

  // 3 占到 35mm：字段行数越多，这里的空段越短。
  //    字号变小时字形在定高行里下沉（量测：每小 1pt 约沉 1.02pt），空段同步缩短抵掉
  //    （见 docs/版式.md 坑 13）。套打不画字形，不补。
  const sink = o.preprinted ? 0 : Math.round((MARK_SIZE_PT - markSizePt) * MARK_SINK_TW_PER_PT);
  const spacer = MARK_TOP - fields.length * BODY_LINE - MARK_GLYPH_PAD - sink
    + (agencies.length > 1 && !o.preprinted ? JOINT_PAD : 0);
  // exact 行高低于约 100tw 的空段 Word 不认（坑 12）：这时改用标志段的段前距。
  // spacer 为负（三项字段都有、又降了字号）时已无空可让，标志会略低于 35mm。
  const small = agencies.length === 1 && !o.preprinted && spacer > 0 && spacer < MIN_BLANK;
  if (spacer > 0 && !small) out.push(blank(spacer));
  if (o.preprinted) {
    out.push(blank(MARK_LINE));   // 套打：留位不画
  } else if (agencies.length === 1) {
    out.push(markParagraph(agencies[0] + (o.withFile ? "文件" : ""), mo, small ? spacer : 0));
  } else {
    out.push(markTable(agencies, o.withFile, mo));
  }

  // 4 标志下空二行
  out.push(blank(GAP_2LINES));

  // 5 发文字号（+ 签发人）
  const docNo = formatDocNo(o.docNo);
  const signers = o.signers || [];
  if (!signers.length) {
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      indent: zero,
      spacing: { line: BODY_LINE, lineRule: "exact" },
      children: [run(docNo, { font: "FangSong", size: 32 })],
    }));
  } else {
    // 上行文：签发人姓名每行两个、回行与上一行第一个姓名对齐；
    // 发文字号居左空一字，与最后一个签发人姓名同一行。
    const sigRun = (name) => run(name, { font: "KaiTi", size: 32 });
    const label = () => run("签发人：", { font: "FangSong", size: 32 });
    const RIGHT_POS = CONTENT_W - ONE_CHAR;   // 右空一字
    const rows = [];
    for (let i = 0; i < signers.length; i += 2) rows.push(signers.slice(i, i + 2));
    const last = rows[rows.length - 1];

    if (rows.length === 1) {
      // 一行装得下：发文字号居左空一字，「签发人：×　×」居右空一字
      const kids = [label(), sigRun(last[0])];
      if (last[1]) { kids.push(run("　　")); kids.push(sigRun(last[1])); }
      out.push(new Paragraph({
        indent: { firstLine: 0, firstLineChars: 0, left: ONE_CHAR },
        spacing: { line: BODY_LINE, lineRule: "exact" },
        tabStops: [{ type: "right", position: RIGHT_POS }],
        children: [run(docNo, { font: "FangSong", size: 32 }), run("\t"), ...kids],
      }));
    } else {
      // 回行的前几行：居右空一字，首行带「签发人：」前缀
      for (let r = 0; r < rows.length - 1; r++) {
        const kids = [];
        if (r === 0) kids.push(label());
        kids.push(sigRun(rows[r][0]));
        if (rows[r][1]) { kids.push(run("　　")); kids.push(sigRun(rows[r][1])); }
        out.push(new Paragraph({
          alignment: AlignmentType.RIGHT,
          indent: { firstLine: 0, firstLineChars: 0, right: ONE_CHAR },
          spacing: { line: BODY_LINE, lineRule: "exact" },
          children: kids,
        }));
      }
      // 末行：发文字号居左空一字；姓名与上一行第一个姓名左缘对齐。
      // 注意：Word 右对齐时行尾空格悬空、不计入宽度，补空格的办法不成立
      // （2026-10-12 实测：补位后姓名对到了第二个姓名下面）；改用左侧制表位，
      // 按上一行「第一个姓名之前」的字位数定位。
      const prev = rows[rows.length - 2];
      const prevNamesW = prev.reduce((a, n) => a + [...String(n)].length, 0) + 2 * (prev.length - 1);
      const pos = (27 - prevNamesW) * ONE_CHAR;
      if (last.length === 1) {
        out.push(new Paragraph({
          indent: { firstLine: 0, firstLineChars: 0, left: ONE_CHAR },
          spacing: { line: BODY_LINE, lineRule: "exact" },
          tabStops: [{ type: "left", position: pos }],
          children: [run(docNo, { font: "FangSong", size: 32 }), run("\t"), sigRun(last[0])],
        }));
      } else {
        out.push(new Paragraph({
          indent: { firstLine: 0, firstLineChars: 0, left: ONE_CHAR },
          spacing: { line: BODY_LINE, lineRule: "exact" },
          tabStops: [{ type: "right", position: RIGHT_POS }],
          children: [run(docNo, { font: "FangSong", size: 32 }), run("\t"),
            sigRun(last[0]), run("　　"), sigRun(last[1])],
        }));
      }
    }
  }

  // 6 红色分隔线：发文字号之下 4mm，与版心等宽。
  //    套打模式留位要补 30tw（1.5pt）：底边框在 Word 里占实高，数字模式的
  //    红线会把后续内容往下压 1.5pt——实测两模式标题差 0.53mm 就是这么来的。
  //    补上之后数字/套打是同一套坐标（同位对照渲染核过）。
  out.push(new Paragraph({
    indent: zero,
    spacing: { line: o.preprinted ? RED_GAP + 30 : RED_GAP, lineRule: "exact" },
    ...(o.preprinted ? {} : {
      border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: RED, space: 0 } },
    }),
    children: [],
  }));

  // 7 分隔线下空二行（标题落位由这一段给出）
  out.push(blank(GAP_2LINES));
  return out;
}

module.exports = { letterhead, MARK_SIZE_PT, MARK_SINK_TW_PER_PT };
