#!/usr/bin/env python3
"""measure-banji.py —— 版记位置量测（本地验证用）。

硬指标：末条分隔线与公文最后一面的版心下边缘重合（GB/T 9704 7.4.1）。
A4 页高 297mm、下边距 35mm → 版心下边缘在距页顶 262mm 处。

依赖 PyMuPDF：~/.venvs/pdf/bin/python3 tools/measure-banji.py <pdf>
"""
import sys

import fitz

def PT2MM(v):
    return v * 25.4 / 72

def main(pdf_path):
    doc = fitz.open(pdf_path)
    page = doc[-1]   # 版记在最后一面
    lines = []
    for dr in page.get_drawings():
        fill = dr.get("fill") or (1, 1, 1)
        if fill[0] < 0.2 and fill[1] < 0.2 and fill[2] < 0.2:
            for it in dr["items"]:
                if it[0] == "re":
                    r = it[1]
                    if r.height < 3 and r.width > 300:
                        lines.append((r.y0, r.width))
    lines.sort()
    page_h = PT2MM(page.rect.height)
    target = page_h - 35
    print(f"最后一页页高 {page_h:.1f} mm；版心下边缘目标 {target:.2f} mm")
    print(f"候选分隔线 {len(lines)} 条：")
    for y, w in lines:
        mm = PT2MM(y)
        note = "  ← 版心下边缘附近" if abs(mm - target) < 3 else ""
        print(f"  y={mm:.2f} mm  宽={PT2MM(w):.1f} mm{note}")
    if lines:
        print(f"末条线 {PT2MM(lines[-1][0]):.2f} mm（目标 {target:.2f}）")
    for block in page.get_text("dict")["blocks"]:
        for ln in block.get("lines", []):
            for sp in ln["spans"]:
                t = sp["text"].strip()
                if t.startswith("抄送") or "印发" in t:
                    print(f"  文本 {t[:18]!r} y {PT2MM(sp['bbox'][1]):.2f}–{PT2MM(sp['bbox'][3]):.2f} mm")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("用法：measure-banji.py <pdf>")
    main(sys.argv[1])
