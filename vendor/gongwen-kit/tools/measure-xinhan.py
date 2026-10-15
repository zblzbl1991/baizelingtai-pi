#!/usr/bin/env python3
"""measure-xinhan.py —— 信函格式首页量测（本地验证用，GB/T 9704 10.1）。

量的硬指标：
  1. 发文机关标志字形上缘至上页边 —— 30mm
  2. 标志字形下缘至第一条双线 —— 4mm
  3. 两条双线长 —— 170mm，居中
  4. 第二条双线至下页边 —— 20mm
  5. 双线粗细次序 —— 第一条上粗下细，第二条上细下粗
  6. 第一条双线至份号／发文字号字形框上缘 —— 3 号字高的 7/8（14pt ≈ 4.94mm）

依赖 PyMuPDF：~/.venvs/pdf/bin/python3 tools/measure-xinhan.py <pdf>
退出码 0 全部在容差内，1 有超差。
"""
import sys

import fitz

TOL = 0.5  # mm

# 标志字体若是回退字体（没装方正小标宋时 Word 静默换成 SimSun），字形高度不同，
# 量出来的位置差约 3mm，不能拿来校准。没装就设 GONGWEN_FONT_TITLE="Songti SC Black"
# 重出量测件（docs/版式.md 坑 14）。
TITLE_FONTS = ("方正小标宋简体", "FZXiaoBiaoSong", "FZXBS", "STSongti-SC-Black")


def fallback_fonts(spans):
    return sorted({sp["font"] for sp in spans
                   if any("\u4e00" <= ch <= "\u9fff" for ch in sp["text"])
                   and not any(t in sp["font"] for t in TITLE_FONTS)})


def mm(v):
    return v * 25.4 / 72


def red_rects(page):
    """红色细矩形与线段（Word 把边框导成填充矩形或描边线），按 y 排序。"""
    out = []
    for d in page.get_drawings():
        col = d.get("fill") or d.get("color")
        if not col or not (col[0] > 0.9 and col[1] < 0.1 and col[2] < 0.1):
            continue
        r = d["rect"]
        h = r.height if r.height > 0 else (d.get("width") or 0)
        if r.width > 100:
            out.append((r.y0, r.y1 if r.height > 0 else r.y0 + h, r.x0, r.x1))
    return sorted(out)


def group(rects):
    """把相邻的两条细线并成一条双线：返回 [(上线, 下线)]。"""
    pairs, i = [], 0
    while i < len(rects):
        if i + 1 < len(rects) and rects[i + 1][0] - rects[i][0] < 3:
            pairs.append((rects[i], rects[i + 1]))
            i += 2
        else:
            pairs.append((rects[i],))
            i += 1
    return pairs


def main(path):
    page = fitz.open(path)[0]
    H = page.rect.height
    spans = [sp for b in page.get_text("dict")["blocks"] for ln in b.get("lines", []) for sp in ln["spans"] if sp["text"].strip()]
    mark = [sp for sp in spans if sp["color"] == 0xFF0000]
    black = sorted((sp for sp in spans if sp["color"] != 0xFF0000), key=lambda s: s["bbox"][1])
    if not mark:
        print("✗ 没找到红色发文机关标志"); return 1
    bad = fallback_fonts(mark)
    if bad:
        print(f"✗ 标志字体是 {'、'.join(bad)}（回退字体），量出来的数不作数；见 docs/版式.md 坑 14"); return 1
    m0, m1 = min(s["bbox"][1] for s in mark), max(s["bbox"][3] for s in mark)
    pairs = group(red_rects(page))
    if len(pairs) < 2 or any(len(p) != 2 for p in pairs[:2]):
        print("✗ 没找到两条红色双线：", pairs); return 1
    (a1, a2), (b1, b2) = pairs[0], pairs[-1]
    th = lambda r: r[1] - r[0]
    rows = [
        ("标志上缘至上页边", mm(m0), 30.0),
        ("标志下缘至第一条双线", mm(a1[0] - m1), 4.0),
        ("第一条双线长", mm(a1[3] - a1[2]), 170.0),
        ("第二条双线长", mm(b1[3] - b1[2]), 170.0),
        ("双线左缘（居中应为 20mm）", mm(a1[2]), 20.0),
        ("第二条双线下缘至下页边", mm(H - b2[1]), 20.0),
        ("第一条双线至首行字框上缘", mm(black[0]["bbox"][1] - a2[1]), 14 * 25.4 / 72),
    ]
    bad = 0
    for name, got, want in rows:
        ok = abs(got - want) <= TOL
        bad += not ok
        print(f"{'✓' if ok else '✗'} {name}：{got:.2f} mm（应为 {want:.2f}）")
    o1 = th(a1) > th(a2)
    o2 = th(b1) < th(b2)
    print(f"{'✓' if o1 else '✗'} 第一条上粗下细：{th(a1):.2f}pt / {th(a2):.2f}pt")
    print(f"{'✓' if o2 else '✗'} 第二条上细下粗：{th(b1):.2f}pt / {th(b2):.2f}pt")
    bad += (not o1) + (not o2)
    return 1 if bad else 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__); sys.exit(2)
    sys.exit(main(sys.argv[1]))
