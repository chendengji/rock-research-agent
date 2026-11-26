#!/usr/bin/env python3
"""Extract per-page text blocks with bbox (PDF points, top-left origin)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

try:
    import pymupdf as fitz
except ImportError:  # pymupdf < 1.24 exposes only the legacy name
    import fitz


def detect_columns(blocks: list[dict], width: float) -> str:
    if len(blocks) < 6:
        return "single"
    mid = width / 2
    left = right = spanning = 0
    for b in blocks:
        x0, _, x1, _ = b["bbox"]
        if x0 < mid - 20 and x1 > mid + 20:
            spanning += 1
        elif (x0 + x1) / 2 < mid:
            left += 1
        else:
            right += 1
    if left >= 3 and right >= 3 and spanning <= max(2, len(blocks) * 0.2):
        return "two-column"
    return "single"


def order_blocks(blocks: list[dict], width: float, mode: str) -> list[dict]:
    if mode == "single":
        return sorted(blocks, key=lambda b: (round(b["bbox"][1] / 8), b["bbox"][0]))
    mid = width / 2
    left = [b for b in blocks if (b["bbox"][0] + b["bbox"][2]) / 2 < mid]
    right = [b for b in blocks if (b["bbox"][0] + b["bbox"][2]) / 2 >= mid]
    key = lambda b: (round(b["bbox"][1] / 8), b["bbox"][0])
    return sorted(left, key=key) + sorted(right, key=key)


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--pages", help="e.g. 1-5 or 3,7; 1-based, default all")
    args = ap.parse_args()

    doc = fitz.open(args.pdf)
    wanted = None
    if args.pages:
        wanted = set()
        for part in args.pages.split(","):
            if "-" in part:
                a, b = part.split("-", 1)
                wanted.update(range(int(a) - 1, int(b)))
            else:
                wanted.add(int(part) - 1)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    total_chars = 0
    with out.open("w", encoding="utf-8") as fh:
        for i, page in enumerate(doc):
            if wanted is not None and i not in wanted:
                continue
            raw = page.get_text("blocks", sort=False)
            blocks = [
                {"bbox": [round(v, 2) for v in b[:4]], "text": b[4].strip()}
                for b in raw
                if len(b) >= 5 and str(b[4]).strip()
            ]
            mode = detect_columns(blocks, page.rect.width)
            blocks = order_blocks(blocks, page.rect.width, mode)
            total_chars += sum(len(b["text"]) for b in blocks)
            rec = {
                "page_index": i,
                "width": round(page.rect.width, 2),
                "height": round(page.rect.height, 2),
                "rotation": page.rotation,
                "order": mode,
                "blocks": blocks,
            }
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")

    n = len(doc)
    print(json.dumps({
        "ok": True,
        "pages": n,
        "chars_per_page": round(total_chars / max(1, n), 1),
        "scanned_suspect": total_chars / max(1, n) < 200,
        "out": str(out),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
