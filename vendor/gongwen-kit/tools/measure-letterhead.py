#!/usr/bin/env python3
"""measure-letterhead.py —— 版头位置量测（本地验证用）。

量的是 GB/T 9704 的两个硬指标：
  1. 发文机关标志（红色文字）字形上缘至版心上边缘 —— 应为 35mm
  2. 红色分隔线 —— 发文字号之下 4mm
再打印发文字号与标题的纵向位置作参考（题头「下空二行」的检核）。

依赖 PyMuPDF：~/.venvs/pdf/bin/python3 tools/measure-letterhead.py <pdf>
"""
import sys

import fitz

# 标志字体若是回退字体（没装方正小标宋时 Word 静默换成 SimSun），字形高度不同，
# 量出来的位置差约 3mm，不能拿来校准。没装就设 GONGWEN_FONT_TITLE="Songti SC Black"
# 重出量测件（docs/版式.md 坑 14）。
TITLE_FONTS = ("方正小标宋简体", "FZXiaoBiaoSong", "FZXBS", "STSongti-SC-Black")


def fallback_fonts(spans):
    return sorted({sp["font"] for sp in spans
                   if any("\u4e00" <= ch <= "\u9fff" for ch in sp["text"])
                   and not any(t in sp["font"] for t in TITLE_FONTS)})


def PT2MM(v):
    return v * 25.4 / 72

def main(pdf_path):
    doc = fitz.open(pdf_path)
    page = doc[0]
    spans = []
    red_tops = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            for sp in line["spans"]:
                spans.append(sp)
                if sp["color"] == 0xFF0000 and sp["text"].strip():
                    red_tops.append(sp["bbox"][1])

    bad = fallback_fonts([sp for sp in spans if sp["color"] == 0xFF0000])
    if bad:
        sys.exit(f"✗ 标志字体是 {'、'.join(bad)}（回退字体），量出来的数不作数；见 docs/版式.md 坑 14")

    line_ys = []
    for dr in page.get_drawings():
        col = dr.get("color") or (0, 0, 0)
        fill = dr.get("fill") or (0, 0, 0)
        red_stroke = col[0] > 0.85 and col[1] < 0.2 and col[2] < 0.2
        red_fill = fill[0] > 0.85 and fill[1] < 0.2 and fill[2] < 0.2
        for it in dr["items"]:
            if it[0] == "l" and red_stroke:
                a, b = it[1], it[2]
                if abs(a.y - b.y) < 0.8:
                    line_ys.append(a.y)
            elif it[0] == "re" and (red_fill or red_stroke):
                r = it[1]
                if r.height < 3:      # 细长矩形＝分隔线
                    line_ys.append(r.y0)

    print(f"页顶 0　版心顶（页顶+37mm）= 37.00 mm（基线）")
    if red_tops:
        y = min(red_tops)
        print(f"发文机关标志字形上缘：{PT2MM(y):.2f} mm（页顶起）"
              f" → 距版心顶 {PT2MM(y) - 37:.2f} mm（目标 35.00）")
    else:
        print("没找到红色文字（套打模式？）")

    docno = [sp for sp in spans if "〔" in sp["text"]]
    if docno:
        sp = docno[-1]
        print(f"发文字号行：{PT2MM(sp['bbox'][1]):.2f}–{PT2MM(sp['bbox'][3]):.2f} mm")
    if line_ys:
        ly = sorted(set(round(y, 1) for y in line_ys))[0]
        msg = f"红色分隔线：{PT2MM(ly):.2f} mm"
        if docno:
            msg += f" → 距发文字号字底 {PT2MM(ly) - PT2MM(docno[-1]['bbox'][3]):.2f} mm（目标 4.00）"
        print(msg)
        below = [sp for sp in spans if sp["bbox"][1] > ly and sp["size"] > 15 and sp["text"].strip()]
        if below:
            sp = min(below, key=lambda s: s["bbox"][1])
            print(f"标题首行：{PT2MM(sp['bbox'][1]):.2f}–{PT2MM(sp['bbox'][3]):.2f} mm"
                  f" → 距红线 {PT2MM(sp['bbox'][1]) - PT2MM(ly):.2f} mm（题头「下空二行」参考）")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("用法：measure-letterhead.py <pdf>")
    main(sys.argv[1])
