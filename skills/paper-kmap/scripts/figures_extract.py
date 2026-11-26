#!/usr/bin/env python3
"""Clean zotero-cli layout output into source/figures.json.

Layout returns one region per detected drawing/table/image box. Many are vector
fragments (confidence=low, no caption) that belong to a multi-panel figure; the
one panel that carries the caption is the anchor. This script:

  1. drops fragments that cannot be merged onto any anchor (noise);
  2. merges same-page fragments whose y-gap < --y-gap and x-overlap > 30%
     onto the nearest anchor, growing its bbox;
  3. numbers F1..Fn by (page, y) and tags a role from the caption text;
  4. backfills a missing caption from the page text (Fig. N ...) when
     source/pages.jsonl is present.

Output schema (one record per figure):
  {id, page(1-based), page_index(0-based), label, caption, bbox[x,y,w,h],
   rect_arg, role, source, confidence, crop}

Reads layout JSON either by calling zotero-cli or from --layout-json.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path


def zotero_cli(args: list[str]) -> dict:
    cmd = ["zotero-cli", "--json", *args]
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    proc = subprocess.run(cmd, capture_output=True, env=env)
    raw = proc.stdout or b""
    if not raw.strip():
        raise RuntimeError(f"zotero-cli failed: {' '.join(cmd)}\n{proc.stderr!r}")
    for enc in ("utf-8", "gbk"):
        try:
            return json.loads(raw.decode(enc))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
    raise RuntimeError(f"cannot parse zotero-cli output: {raw[:200]!r}")


def union(a: list[float], b: list[float]) -> list[float]:
    x0 = min(a[0], b[0])
    y0 = min(a[1], b[1])
    x1 = max(a[0] + a[2], b[0] + b[2])
    y1 = max(a[1] + a[3], b[1] + b[3])
    return [round(x0, 4), round(y0, 4), round(x1 - x0, 4), round(y1 - y0, 4)]


def v_gap(a: list[float], b: list[float]) -> float:
    """Vertical separation between two normalized bboxes (0 if they overlap)."""
    a_bot, b_bot = a[1] + a[3], b[1] + b[3]
    if a[1] >= b_bot:
        return a[1] - b_bot
    if b[1] >= a_bot:
        return b[1] - a_bot
    return 0.0


def x_overlap(a: list[float], b: list[float]) -> float:
    x0 = max(a[0], b[0])
    x1 = min(a[0] + a[2], b[0] + b[2])
    return max(0.0, x1 - x0)


def role_of(label: str | None, caption: str | None) -> str:
    text = f"{label or ''} {caption or ''}".lower()
    if re.search(r"\btable\b", text):
        return "table"
    if re.search(r"schematic|workflow|apparatus|test (method|setup)|set[- ]?up", text):
        return "method"
    if re.search(r"variation|relationship|comparison|\bvs\b|versus|cross[- ]?plot|depend|correlat", text):
        return "result"
    return "figure"


def clean_layout(regions: list[dict], y_gap: float = 0.02, pages: dict[int, str] | None = None) -> tuple[list[dict], list[dict]]:
    by_page: dict[int, list[dict]] = {}
    for r in regions:
        by_page.setdefault(int(r["page"]), []).append(r)

    kept: list[dict] = []
    dropped: list[dict] = []
    for page in sorted(by_page):
        regs = by_page[page]
        anchors = [r for r in regs if r.get("caption_label")]
        frags = [r for r in regs if not r.get("caption_label")]

        for f in frags:
            fb = f["bbox"]
            best, best_gap = None, None
            for a in anchors:
                ab = a["bbox"]
                gap = v_gap(fb, ab)
                if gap > y_gap:
                    continue
                if x_overlap(fb, ab) < 0.3 * min(fb[2], ab[2]):
                    continue
                if best is None or gap < best_gap:
                    best, best_gap = a, gap
            if best is None:
                dropped.append({"page": page, "bbox": fb, "why": "no anchor within y-gap"})
                continue
            best["bbox"] = union(best["bbox"], fb)
            best.setdefault("merged_from", []).append({"page": page, "bbox": fb})
            best["source"] = "merged" if best.get("source") != "merged" else best["source"]
        kept.extend(anchors)

    kept.sort(key=lambda r: (int(r["page"]), r["bbox"][1], r["bbox"][0]))
    out = []
    for i, r in enumerate(kept, start=1):
        page = int(r["page"])
        caption = r.get("caption_text") or None
        if not caption and pages and (page - 1) in pages:
            m = re.search(r"Fig\.?\s*\d+\.?\s*([^\n]{5,220})", pages[page - 1])
            if m:
                caption = m.group(1).strip()
        bbox = [round(v, 4) for v in r["bbox"]]
        out.append({
            "id": f"F{i}",
            "page": page,
            "page_index": page - 1,
            "label": r.get("caption_label"),
            "caption": caption,
            "bbox": bbox,
            "rect_arg": ",".join(f"{v:.4f}" for v in bbox),
            "role": role_of(r.get("caption_label"), caption),
            "source": r.get("source", "drawing"),
            "confidence": r.get("confidence", "low"),
            "crop": None,
        })
    return out, dropped


def load_pages(path: Path) -> dict[int, str]:
    pages: dict[int, str] = {}
    if not path.exists():
        return pages
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        pages[rec["page_index"]] = "\n".join(b.get("text", "") for b in rec.get("blocks", []))
    return pages


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--attachment-key", required=True)
    ap.add_argument("--paper-dir", default=".")
    ap.add_argument("--layout-json", help="use a previously dumped layout JSON instead of zotero-cli")
    ap.add_argument("--out", default="source/figures.json")
    ap.add_argument("--y-gap", type=float, default=0.02, help="merge fragments within this y gap")
    args = ap.parse_args()

    d = Path(args.paper_dir).resolve()
    if args.layout_json:
        raw = json.loads(Path(args.layout_json).read_text(encoding="utf-8-sig"))
    else:
        raw = zotero_cli(["layout", args.attachment_key, "--pages", "all"])
    regions = (raw.get("data") or {}).get("regions", [])

    pages = load_pages(d / "source" / "pages.jsonl")
    figures, dropped = clean_layout(regions, args.y_gap, pages)

    out = d / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(figures, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps({
        "ok": True,
        "figures": len(figures),
        "dropped": len(dropped),
        "out": str(out),
        "roles": {r: sum(1 for f in figures if f["role"] == r) for r in sorted({f["role"] for f in figures})},
        "no_caption": [f["id"] for f in figures if not f["caption"]],
        "drop_examples": dropped[:5],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
