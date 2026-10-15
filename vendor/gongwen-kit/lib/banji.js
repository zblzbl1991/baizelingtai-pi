"use strict";
/**
 * banji.js —— 版记构件（GB/T 9704 7.4）。
 *
 * 要素与规则（对照扫描件逐条核过）：
 *   分隔线    与版心等宽；首条粗线（0.35mm）在版记第一个要素之上，末条粗线
 *             （0.35mm）与公文最后一面的版心下边缘重合，中间用细线（0.25mm）隔开（7.4.1）
 *   抄送机关   4 号仿宋，在印发机关和印发日期之上一行、左右各空一字；
 *             「抄送」后加全角冒号，回行与冒号后的首字对齐，最后一个机关
 *             名称后标句号（7.4.2，图 5 里机关之间用逗号）
 *   印发机关和印发日期  4 号仿宋，编排在末条分隔线之上；机关左空一字、
 *             日期右空一字，日期用阿拉伯数字标全、后加「印发」二字（7.4.3）
 *
 * 位置：版记的每个段落带同一套 framePr，Word 把它们并成一个浮动框架，
 * 底边锚在版心下边缘（vAnchor=text、yAlign=bottom）——「末条线与版心
 * 下边缘重合」由它保证，不需要猜最后一页还剩多少空白。
 * 页脚方案不用：页脚在版心下边缘之下（页码就住在那里），与条款冲突。
 *
 * 边界：不支持「主送机关移至版记」（7.4.2 后半）与版记内其他自定义要素，
 * 需要时按同一套段落手工拼。
 */
const {
  Paragraph, TextRun, Tab, HeightRule, FrameAnchorType, FrameWrap,
  HorizontalPositionAlign, VerticalPositionAlign, BorderStyle,
} = require("docx");

const CONTENT_W = 8844;    // 版心宽 156mm
const SZ4 = 28;            // 4 号字 = 14pt（half-points）
const CHAR4 = 280;         // 4 号字一个全角宽（14pt = 280tw）
const LINE4 = 396;         // 4 号字的行高（19.8pt，比正文紧，版记惯例）
const LINE_THICK = 8;      // 粗线 1pt ≈ 0.35mm
const LINE_THIN = 6;       // 细线 0.75pt ≈ 0.26mm
const GAP_LINE = 120;      // 分隔线到文字之间的空段高
const GAP_BOTTOM = 60;     // 末条线前的空段高

// 同一套 framePr 必须逐字段相同，Word 才会把连续段落并进同一个框架；
// 不同则各起一框、各自锚底，会叠在一起。
// 锚必须用 margin（版心下边缘＝页边距下缘）：2026-10-12 对照实验，
// vAnchor=text 根本不浮动（留在正文流里），vAnchor=page 会落到下边距
// 以下（多出一个下边距的距离），只有 margin 正好压在版心下边缘。
const FRAME = {
  type: "alignment",
  width: CONTENT_W,
  height: 1600,
  rule: HeightRule.AUTO,
  wrap: FrameWrap.NOT_BESIDE,
  anchor: { horizontal: FrameAnchorType.TEXT, vertical: FrameAnchorType.MARGIN },
  alignment: { x: HorizontalPositionAlign.CENTER, y: VerticalPositionAlign.BOTTOM },
};

const run4 = (text) => new TextRun({
  text: String(text),
  font: { eastAsia: "FangSong", ascii: "FangSong", hAnsi: "FangSong" },
  size: SZ4,
});

// 一条分隔线：空段落，底边框即线，段落高度决定线与文字的间距
const rule = (size, h) => new Paragraph({
  frame: FRAME,
  spacing: { line: h, lineRule: "exact" },
  border: { bottom: { style: BorderStyle.SINGLE, size, color: "000000", space: 0 } },
  children: [],
});

/** 版记。返回段落序列，接在正文（落款）之后。 */
function banji(opts = {}) {
  const o = { ...opts };
  // 信函格式（10.1）：版记只留抄送，不加印发机关、印发日期和分隔线
  if (o.letter) {
    if (!o.copyTo || !o.copyTo.length) return [];
    const names = Array.isArray(o.copyTo) ? o.copyTo : [o.copyTo];
    return [new Paragraph({
      frame: FRAME,
      indent: { left: CHAR4 * 4, right: CHAR4, hanging: CHAR4 * 3, firstLineChars: 0 },
      spacing: { line: LINE4, lineRule: "exact" },
      children: [run4("抄送：" + names.join("，") + "。")],
    })];
  }
  if (!o.issuer || !o.date) {
    throw new Error("版记要有印发机关（issuer）和印发日期（date）");
  }
  const out = [];

  // 首条粗线
  out.push(rule(LINE_THICK, GAP_LINE));

  // 抄送机关（可选）
  if (o.copyTo && o.copyTo.length) {
    const names = Array.isArray(o.copyTo) ? o.copyTo : [o.copyTo];
    out.push(new Paragraph({
      frame: FRAME,
      // 回行与冒号后首字对齐：左 4 字位、悬挂 3 字位，首行落 1 字位。
      // **firstLineChars 必须显式归零**：Normal 样式（正文体例）带
      // firstLineChars=200 的两字首行缩进，段落缩进与样式逐属性合并时
      // 它压过了 hanging，首行会被顶到 6 字位（2026-10-12 实测）。
      indent: { left: CHAR4 * 4, right: CHAR4, hanging: CHAR4 * 3, firstLineChars: 0 },
      spacing: { line: LINE4, lineRule: "exact" },
      children: [run4("抄送：" + names.join("，") + "。")],
    }));
    // 其他要素与印发机关之间用细分隔线隔开（7.4.3）
    out.push(rule(LINE_THIN, GAP_LINE));
  }

  // 印发机关和印发日期
  out.push(new Paragraph({
    frame: FRAME,
    indent: { left: CHAR4, firstLine: 0, firstLineChars: 0 },
    spacing: { line: LINE4, lineRule: "exact" },
    tabStops: [{ type: "right", position: CONTENT_W - CHAR4 }],
    children: [run4(o.issuer), run4("\t"), run4(o.date + "印发")],
  }));

  // 末条粗线：与最后一面的版心下边缘重合
  out.push(rule(LINE_THICK, GAP_BOTTOM));
  return out;
}

module.exports = { banji };
