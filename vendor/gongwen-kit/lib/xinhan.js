"use strict";
/**
 * xinhan.js —— 信函格式（GB/T 9704 10.1）。
 *
 * 要素与规则（对照标准原文逐条核过）：
 *   发文机关标志  全称或规范化简称，不加「文件」；居中，上边缘至上页边 30mm；
 *              红色小标宋。联合行文只用主办机关标志
 *   第一条红色双线  标志下 4mm，上粗下细，长 170mm，居中
 *   第二条红色双线  距下页边 20mm，上细下粗，长 170mm，居中
 *   份号/密级/紧急程度  顶格居版心左边缘，在第一条双线下分行排；第一个要素
 *              与线相距 3 号字高的 7/8
 *   发文字号    顶格居版心右边缘，在第一条双线下，与线相距 3 号字高的 7/8
 *   标题        与其上最后一个要素相距二行
 *   首页不显示页码；版记只留抄送，不加印发机关、印发日期和分隔线（见 banji.js）
 *
 * 位置：标志与两条双线都在版心之外（30mm 在版心上边缘 37mm 之上，170mm 比
 * 版心宽 14mm），所以放进首页页眉／页脚，用页面锚定的绝对框架定位，不进
 * 正文流。
 * 常数是渲染量测校准值：改之前先跑 tools/measure-xinhan.py，改完重量。
 * 量测件的标志必须是小标宋或 Songti SC Black，回退字体量出来的数不作数（docs/版式.md 坑 14）。
 */
const {
  Paragraph, TextRun, AlignmentType, BorderStyle, HeightRule,
  FrameAnchorType, FrameWrap, Header, Footer,
} = require("docx");
// 标志字号（小初，国标未定、按醒目庄重酌定）与降号下沉常数，和版头共用一套校准值
const { MARK_SIZE_PT, MARK_SINK_TW_PER_PT } = require("./letterhead");

const MM = 56.7;                    // 1mm = 56.7 twips
const PAGE_LEFT = 1587;             // 左页边 28mm（版心左缘）
const CONTENT_W = 8844;             // 版心宽 156mm
const RULE_W = Math.round(170 * MM);              // 双线长 170mm
// Word 画段落边框时比框架两侧各多出约 0.5mm：框架收窄、左移，量出来正好 170mm
const RULE_DRAW_W = RULE_W - 58;
const RULE_X = PAGE_LEFT - Math.round((RULE_W - CONTENT_W) / 2) - 23;
const BODY_LINE = 579;              // 正文行高
const RED = "FF0000";

// ── 量测校准值（tools/measure-xinhan.py）──────────────────
const MARK_Y = Math.round(30 * MM); // 标志框架上缘；字形顶部留白由 MARK_PAD 抵掉
const MARK_PAD = 101;
const MARK_LINE = 1080;
const RULE1_GAP = 253;              // 标志框架底至第一条双线
const RULE1_SHRINK = 7.1;           // 标志字号每小 1pt，第一条双线在框架补偿之外再上移的 twips（30／24pt 量测）
const RULE2_Y = Math.round((297 - 20) * MM) - 78;   // 双线下缘落在 20mm
// 页眉里的框架会把正文顶下去：正文从页眉范围的底边（第一条双线框架底）起排，
// 不从版心上缘起排。所以补的只是线下到首行的那一段（7/8 字高），用首行的
// 段前距补：单独垫一个空段不成立，exact 行高低于约 100tw 时 Word 不认
// （2026-10-13 实测：47tw 与 95tw 量出同一个位置）。
const ROW1_SPACER = 49;

const run = (text, { font, size, color } = {}) => new TextRun({
  text: String(text),
  font: font ? { eastAsia: font, ascii: font, hAnsi: font } : undefined,
  size, color,
});
const zero = { firstLine: 0, firstLineChars: 0 };

const frameAt = (x, y, width, height) => ({
  type: "absolute",
  position: { x, y },
  width, height,
  rule: HeightRule.EXACT,
  wrap: FrameWrap.AROUND,
  anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE },
});

// 双线用段落的上边框画。Word 对上边框的线序与样式名相反（量测核过）：
// thinThickSmallGap 画出来上粗下细，thickThinSmallGap 画出来上细下粗
const rule = (y, style) => new Paragraph({
  frame: frameAt(RULE_X, y, RULE_DRAW_W, 120),
  indent: zero,
  spacing: { line: 120, lineRule: "exact" },
  border: { top: { style, size: 18, color: RED, space: 0 } },
  children: [],
});

function markSize(name, size) {
  const n = [...String(name)].length;
  let s = size;
  while (s > 22 && n * s * 20 > CONTENT_W) s -= 2;
  if (n * s * 20 > CONTENT_W) {
    throw new Error(`信函发文机关标志 ${n} 字，降到二号仍超出版心宽、会回行被裁掉；改用规范化简称`);
  }
  return s;
}

/** 信函的节属性：首页页眉画标志与第一条双线，首页页脚画第二条双线、不印页码；
 *  其余页沿用 base（sectionProps() 的返回）的单双页页码。 */
function xinhanSection(base, opts = {}) {
  const o = { markSizePt: MARK_SIZE_PT, markFont: "Songti SC Black", ...opts };
  if (!o.agency) throw new Error("信函要有发文机关标志：agency");
  const agency = Array.isArray(o.agency) ? o.agency[0] : o.agency;   // 联合行文只用主办机关
  const size = markSize(agency, o.markSizePt);
  // 字号变小时字形在定高行里下沉，框架同步上移抵掉（与 letterhead.js 同一校准值）
  const shrink = MARK_SIZE_PT - size;
  const markY = MARK_Y - MARK_PAD - Math.round(shrink * MARK_SINK_TW_PER_PT);
  // 字形同时变矮，下缘上移：第一条双线再跟着上移，保持「标志下 4mm」
  const rule1Y = markY + MARK_LINE + RULE1_GAP - Math.round(shrink * RULE1_SHRINK);
  const first = new Header({
    children: [
      new Paragraph({
        frame: frameAt(PAGE_LEFT, markY, CONTENT_W, MARK_LINE),
        alignment: AlignmentType.CENTER,
        indent: zero,
        spacing: { line: MARK_LINE, lineRule: "exact" },
        children: [run(agency, { font: o.markFont, size: size * 2, color: RED })],
      }),
      rule(rule1Y, BorderStyle.THIN_THICK_SMALL_GAP),
    ],
  });
  return {
    ...base,
    properties: { ...base.properties, titlePage: true },
    headers: { ...(base.headers || {}), first },
    footers: {
      ...(base.footers || {}),
      first: new Footer({ children: [rule(RULE2_Y, BorderStyle.THICK_THIN_SMALL_GAP)] }),
    },
  };
}

/** 信函首页正文开头：份号等要素（左）与发文字号（右），再空二行接标题。 */
function xinhanHead(opts = {}) {
  const left = [];
  if (opts.copyNo != null) left.push(String(opts.copyNo).padStart(6, "0"));
  if (opts.secret) left.push(opts.secret);
  if (opts.urgency) left.push(opts.urgency);
  const docNo = opts.docNo == null ? ""
    : typeof opts.docNo === "string" ? opts.docNo
      : `${opts.docNo.dept}〔${opts.docNo.year}〕${opts.docNo.seq}号`;

  const out = [];
  const rows = Math.max(left.length, docNo ? 1 : 0);
  for (let i = 0; i < rows; i++) {
    const kids = [];
    if (left[i]) kids.push(run(left[i], { font: "SimHei", size: 32 }));
    if (i === 0 && docNo) kids.push(run("\t"), run(docNo, { font: "FangSong", size: 32 }));
    out.push(new Paragraph({
      indent: zero,
      spacing: { line: BODY_LINE, lineRule: "exact", ...(i === 0 ? { before: ROW1_SPACER } : {}) },
      tabStops: [{ type: "right", position: CONTENT_W }],
      children: kids,
    }));
  }
  out.push(new Paragraph({ indent: zero, spacing: { line: BODY_LINE * 2, lineRule: "exact" }, children: [] }));
  return out;
}

module.exports = { xinhanSection, xinhanHead };
