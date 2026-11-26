#!/usr/bin/env python3
"""Locally crop paper figures from a PDF (no Zotero dependency).

Finds figure captions ("Fig. N" / "Figure N" / "Fig N."), crops the region
above each caption (bounded by the previous caption or the page header), and
saves figs/F<n>.png. Agent decides which figures to take (--pages / --all);
this is the "autonomous screenshot" path, separate from Zotero batch images.

Usage:
  figures_local.py --pdf source/paper.pdf --out figs           # all pages
  figures_local.py --pdf source/paper.pdf --out figs --pages 5  # page 5 only
  figures_local.py --pdf source/paper.pdf --out figs --figs 3,4 # Fig.3 & 4 only

Output: figs/F<n>.png + prints a JSON manifest (page/rect/caption).
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import fitz  # pymupdf

# Caption patterns: "Fig. 3.", "Figure 3.", "Fig 3." (caption ends with a period;
# body-text refs like "Fig. 2 demonstrates" have no period after the number).
CAP = re.compile(r"^\s*(?:Fig(?:ure)?\.?)\s*(\d+)\.\s", re.I)


def find_captions(page) -> list[dict]:
    """Return captions (number + bbox y) on a page, top-to-bottom."""
    out = []
    for b in page.get_text("blocks"):
        txt = (b[4] or "").strip()
        m = CAP.match(txt)
        if m and b[1] < page.rect.height * 0.95:  # skip page footer area
            out.append({"n": int(m.group(1)), "y0": b[1], "y1": b[3], "text": txt[:70]})
    out.sort(key=lambda c: c["y0"])
    return out


def figure_rect(page, prev_y1, cap_y0, margin: float) -> "fitz.Rect":
    """Region between previous element bottom and caption top."""
    top = (prev_y1 + 4) if prev_y1 else 80  # 80pt = below page header
    bot = cap_y0 - 3
    if bot - top < 40:  # too small to be a figure
        return None
    return fitz.Rect(margin, top, page.rect.width - margin, bot)


def crop_figures(pdf: str, out: Path, pages=None, figs=None, zoom: int = 3, margin: float = 10) -> list[dict]:
    doc = fitz.open(pdf)
    results = []
    seen = set()
    for pno in range(len(doc)):
        if pages and (pno + 1) not in pages:
            continue
        page = doc[pno]
        caps = find_captions(page)
        if not caps:
            continue
        prev_y1 = None
        for cap in caps:
            if figs and cap["n"] not in figs:
                prev_y1 = cap["y1"]  # still track boundary even if skipped
                continue
            if cap["n"] in seen:
                prev_y1 = cap["y1"]
                continue
            rect = figure_rect(page, prev_y1, cap["y0"], margin)
            if rect is None:
                prev_y1 = cap["y1"]
                continue
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), clip=rect)
            fn = out / f"F{cap['n']}.png"
            pix.save(str(fn))
            results.append({
                "fig": cap["n"], "page": pno + 1, "file": str(fn),
                "rect": [round(v, 1) for v in rect], "caption": cap["text"],
            })
            seen.add(cap["n"])
            prev_y1 = cap["y1"]
    doc.close()
    return results


def main() -> int:
    ap = argparse.ArgumentParser(description="Locally crop paper figures from a PDF.")
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--out", default="figs")
    ap.add_argument("--pages", default="", help="comma-separated page numbers (default all)")
    ap.add_argument("--figs", default="", help="comma-separated figure numbers to keep (default all)")
    ap.add_argument("--zoom", type=int, default=3)
    ap.add_argument("--margin", type=float, default=10)
    args = ap.parse_args()

    pdf = Path(args.pdf).resolve()
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    pages = {int(x) for x in args.pages.split(",")} if args.pages else None
    figs = {int(x) for x in args.figs.split(",")} if args.figs else None

    res = crop_figures(str(pdf), out, pages=pages, figs=figs, zoom=args.zoom, margin=args.margin)
    print(json.dumps({"ok": True, "figures": len(res), "items": res}, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
