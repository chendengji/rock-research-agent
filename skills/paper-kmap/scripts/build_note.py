#!/usr/bin/env python3
"""Build a one- or two-page paper-note PPTX from note.json.

This is the "paper as personal note" deck: a single paper condensed onto 1–2
slides, structured around the community consensus for literature notes
(Keshav three-pass + journal-club ordering + one-pager balance):

  question(gap) -> method -> key results (paper's own figures) ->
  conclusion -> limits -> MY insights (coloured) -> how I'll reuse it

Colour semantics follow the note-taking convention:
  red   = the authors' words (quoted, objective)
  blue  = my own thinking / insight
  yellow= open questions to verify later

Input is note.json (schema note/1), built by the agent from knowledge.v2.json
+ annotations.json + the reader's own judgement. The existing 10-page seminar
deck (build_deck.py) is a separate product and is untouched here.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.util import Inches, Pt

from build_deck import (W, H, MARGIN, FONT, DARK, MUTED, ACCENT, LIGHT,
                        add_picture, contain, textbox)

# note-taking colour semantics
AUTHOR = RGBColor(0x8A, 0x1C, 0x1C)      # red  = authors' words
MINE = RGBColor(0x1F, 0x4E, 0x79)        # blue = my insight
TODO = RGBColor(0xB8, 0x86, 0x0B)        # amber= open question
MINE_BG = RGBColor(0xEE, 0xF4, 0xFF)
TODO_BG = RGBColor(0xFF, 0xFA, 0xE6)

L = 5.7            # left column width
R = 5.8            # right column width
GUT = 0.45         # gap between columns


def _tag(slide, x, y, w, text, color, size=11):
    textbox(slide, x, y, w, 0.3, text, size=size, bold=True, color=color)


def _card(slide, x, y, w, h, tag, color, bg=None):
    if bg is not None:
        box = slide.shapes.add_shape(1, Inches(x), Inches(y), Inches(w), Inches(h))
        box.fill.solid()
        box.fill.fore_color.rgb = bg
        box.line.fill.background()
    _tag(slide, x + 0.12, y + 0.08, w - 0.24, tag, color)
    return x + 0.12, y + 0.42, w - 0.24, h - 0.55


def _bullets(slide, x, y, w, h, items, size=13, color=DARK):
    if not items:
        return
    text = "\n".join(f"• {t}" for t in items)
    textbox(slide, x, y, w, h, text, size=size, color=color, spacing=1.12)


def _figure(slide, base, fig, x, y, w, h):
    rel = fig.get("figure") or fig.get("path")
    if not rel:
        return y + h
    path = (base / rel).resolve()
    if path.suffix.lower() == ".svg":
        png = path.with_suffix(".png")
        if png.exists():
            path = png
        else:
            textbox(slide, x, y, w, 0.6, f"[缺图] {rel}", size=12, color=AUTHOR)
            return y + h
    if path.exists():
        box = contain(path, (x, y, w, h))
        add_picture(slide, path, box)
        y = box[1] + box[3]  # 紧贴图实际底部（非区域底部）
    else:
        textbox(slide, x, y, w, 0.6, f"[缺图] {rel}", size=12, color=AUTHOR)
        y += h
    cap = fig.get("caption")
    if cap:
        textbox(slide, x, y, w, 0.4, cap, size=11, color=MUTED)
        y += 0.4
    take = fig.get("take")
    if take:
        textbox(slide, x, y, w, 0.45, f"作者：{take}", size=11, color=AUTHOR)
        y += 0.45
    return y + 0.15


def _header(slide, note):
    meta = note.get("meta", {})
    cite = meta.get("citekey", "")
    title = meta.get("title", "")
    authors = meta.get("author", "")
    venue = meta.get("venue", "")
    year = meta.get("year", "")
    doi = meta.get("doi", "")
    meta_line = " · ".join(x for x in [cite, f"{authors} ({year})" if authors else "",
                                       venue, f"DOI {doi}" if doi else ""] if x)
    textbox(slide, MARGIN, 0.42, W - 2 * MARGIN, 0.5, title, size=24, bold=True, color=DARK)
    if meta_line:
        textbox(slide, MARGIN, 0.92, W - 2 * MARGIN, 0.3, meta_line, size=11, color=MUTED)
    take = note.get("takeaway")
    if take:
        textbox(slide, MARGIN, 1.28, W - 2 * MARGIN, 0.6, f"主要内容：{take}",
                size=15, bold=True, color=MINE)
    line = slide.shapes.add_shape(1, Inches(MARGIN), Inches(1.95), Inches(W - 2 * MARGIN), Inches(0.03))
    line.fill.solid()
    line.fill.fore_color.rgb = RGBColor(0xCF, 0xD8, 0xE3)
    line.line.fill.background()


def _page1(prs, note, base):
    sl = prs.slides.add_slide(prs.slide_layouts[6])
    _header(sl, note)

    # left column: question(gap) + method
    q = note.get("question", {})
    x, y, w, h = _card(sl, MARGIN, 2.15, L, 1.75, "作者 · 研究问题", AUTHOR)
    if q.get("text"):
        textbox(sl, x, y, w, h, q["text"], size=14, color=DARK)
    if q.get("gap"):
        textbox(sl, x, y + 0.7, w, h - 0.7, f"缺口：{q['gap']}", size=12, color=MUTED)

    x, y, w, h = _card(sl, MARGIN, 4.05, L, 2.85, "作者 · 核心方法", AUTHOR)
    _bullets(sl, x, y, w, h, note.get("method", []), size=13)

    # right column: key results (paper's own figures)
    x = MARGIN + L + GUT
    _tag(sl, x, 2.15, R, "作者 · 关键结果（原文图）", AUTHOR)
    yy = 2.5
    results = note.get("results", [])
    if not results:
        textbox(sl, x, yy, R, 1, "[未填 results]", size=13, color=MUTED)
    else:
        per = 4.4 / max(1, len(results))
        for fig in results[:2]:
            yy = _figure(sl, base, fig, x, yy, R, max(1.4, per))
    return sl


def _page2(prs, note, base):
    sl = prs.slides.add_slide(prs.slide_layouts[6])
    _header(sl, note)

    # left: conclusion + limits (authors' words)
    x, y, w, h = _card(sl, MARGIN, 2.15, L, 2.5, "作者 · 结论 / 创新点", AUTHOR)
    _bullets(sl, x, y, w, h, note.get("conclusion", []), size=13)
    x, y, w, h = _card(sl, MARGIN, 4.85, L, 2.05, "作者 · 局限", AUTHOR)
    _bullets(sl, x, y, w, h, note.get("limits", []), size=12)

    # right: my insights (blue) + open questions (amber)
    rx = MARGIN + L + GUT
    x, y, w, h = _card(sl, rx, 2.15, R, 2.5, "我的思考", MINE, bg=MINE_BG)
    insights = [t for t in note.get("mine", []) if t.get("kind") != "question"]
    _bullets(sl, x, y, w, h, [t["text"] for t in insights], size=13, color=MINE)
    x, y, w, h = _card(sl, rx, 4.85, R, 2.05, "待查证", TODO, bg=TODO_BG)
    todos = [t for t in note.get("mine", []) if t.get("kind") == "question"]
    _bullets(sl, x, y, w, h, [t["text"] for t in todos], size=12, color=RGBColor(0x7A, 0x5A, 0x00))

    reuse = note.get("reuse")
    if reuse:
        textbox(sl, MARGIN, 6.95, W - 2 * MARGIN, 0.4,
                f"三个月后怎么用：{reuse}", size=11, bold=True, color=ACCENT)
    return sl


def _page1_single(prs, note, base):
    sl = prs.slides.add_slide(prs.slide_layouts[6])
    _header(sl, note)

    # left: question, method, conclusion
    q = note.get("question", {})
    x, y, w, h = _card(sl, MARGIN, 2.15, L, 1.35, "作者 · 研究问题", AUTHOR)
    if q.get("text"):
        textbox(sl, x, y, w, h, q["text"], size=12, color=DARK)
    x, y, w, h = _card(sl, MARGIN, 3.65, L, 1.6, "作者 · 核心方法", AUTHOR)
    _bullets(sl, x, y, w, h, note.get("method", [])[:3], size=12)
    x, y, w, h = _card(sl, MARGIN, 5.4, L, 1.5, "作者 · 结论", AUTHOR)
    _bullets(sl, x, y, w, h, note.get("conclusion", [])[:3], size=12)

    # right: one figure + my insight + todo
    rx = MARGIN + L + GUT
    _tag(sl, rx, 2.15, R, "作者 · 关键结果", AUTHOR)
    yy = 2.5
    results = note.get("results", [])
    if results:
        yy = _figure(sl, base, results[0], rx, yy, R, 1.9)
    else:
        yy += 1.9
    x, y, w, h = _card(sl, rx, 4.6, R, 1.15, "我的思考", MINE, bg=MINE_BG)
    insights = [t["text"] for t in note.get("mine", []) if t.get("kind") != "question"][:2]
    _bullets(sl, x, y, w, h, insights, size=11, color=MINE)
    x, y, w, h = _card(sl, rx, 5.9, R, 1.0, "待查证", TODO, bg=TODO_BG)
    todos = [t["text"] for t in note.get("mine", []) if t.get("kind") == "question"][:2]
    _bullets(sl, x, y, w, h, todos, size=11, color=RGBColor(0x7A, 0x5A, 0x00))
    if note.get("reuse"):
        textbox(sl, MARGIN, 6.95, W - 2 * MARGIN, 0.4,
                f"三个月后怎么用：{note['reuse']}", size=11, bold=True, color=ACCENT)
    return sl


def build(note: dict, base: Path, out: Path, pages: int):
    prs = Presentation()
    prs.slide_width = Inches(W)
    prs.slide_height = Inches(H)
    if pages >= 2:
        _page1(prs, note, base)
        _page2(prs, note, base)
    else:
        _page1_single(prs, note, base)
    out.parent.mkdir(parents=True, exist_ok=True)
    prs.save(out)
    return len(prs.slides)


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--note", required=True, help="note.json (schema note/1)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--pages", type=int, choices=[1, 2], default=2)
    args = ap.parse_args()

    note_path = Path(args.note).resolve()
    note = json.loads(note_path.read_text(encoding="utf-8"))
    base = note_path.parent.parent
    out = Path(args.out).resolve()
    n = build(note, base, out, args.pages)
    print(json.dumps({"ok": True, "pptx": str(out), "slides": n, "pages": args.pages}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
