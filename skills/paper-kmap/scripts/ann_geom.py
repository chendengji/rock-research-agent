#!/usr/bin/env python3
"""Rebuild annotation geometry from a *copy* of zotero.sqlite.

zotero-cli / MCP drop annotationPosition, so read the DB directly (never write).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime
from pathlib import Path

try:
    import pymupdf as fitz
except ImportError:  # pymupdf < 1.24 exposes only the legacy name
    import fitz

TYPE_MAP = {1: "highlight", 2: "note", 3: "image", 4: "ink", 5: "underline", 6: "text"}
COLOR_MAP = {
    "#ffd400": "Yellow", "#ffcd45": "Orange",
    "#ff6666": "Red", "#e44234": "Red",
    "#5fb236": "Green", "#2ea8e5": "Blue",
    "#a28ae5": "Purple", "#e56eee": "Magenta",
    "#f19837": "Orange", "#aaaaaa": "Gray",
}


def find_db(explicit: str | None) -> Path:
    cands = []
    if explicit:
        cands.append(Path(explicit))
    if os.environ.get("ZOTERO_DATA_DIR"):
        cands.append(Path(os.environ["ZOTERO_DATA_DIR"]) / "zotero.sqlite")
    cands += [Path.home() / "Documents" / "Zotero" / "zotero.sqlite", Path.home() / "Zotero" / "zotero.sqlite"]
    for c in cands:
        if c.exists():
            return c
    raise SystemExit("zotero.sqlite not found; pass --db or set ZOTERO_DATA_DIR")


def copy_db(src: Path) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="kmap-zot-"))
    dst = tmp / "zotero.sqlite"
    shutil.copy2(src, dst)
    for suffix in ("-wal", "-shm"):
        side = Path(str(src) + suffix)
        if side.exists():
            shutil.copy2(side, str(dst) + suffix)
    return dst


def load_page_sizes(pdf: str | None) -> dict[int, tuple[float, float]]:
    if not pdf:
        return {}
    doc = fitz.open(pdf)
    return {i: (p.rect.width, p.rect.height) for i, p in enumerate(doc)}


QUERY = """
SELECT i.key AS ann_key,
       a.type        AS ann_type,
       a.text        AS ann_text,
       a.comment     AS ann_comment,
       a.color       AS ann_color,
       a.pageLabel   AS page_label,
       a.position    AS position,
       i.dateModified AS modified,
       att_i.key     AS att_key,
       p.key         AS item_key,
       p.itemID      AS item_id
FROM itemAnnotations a
JOIN items i ON i.itemID = a.itemID
JOIN itemAttachments att ON att.itemID = a.parentItemID
JOIN items att_i ON att_i.itemID = att.itemID
JOIN items p ON p.itemID = att.parentItemID
WHERE p.key = ? AND a.itemID NOT IN (SELECT itemID FROM deletedItems)
ORDER BY a.itemID
"""


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--item-key", required=True)
    ap.add_argument("--db")
    ap.add_argument("--pdf")
    ap.add_argument("--out", required=True)
    ap.add_argument("--config", default=str(Path(__file__).resolve().parent.parent / "templates" / "kmap.config.json"))
    args = ap.parse_args()

    db = copy_db(find_db(args.db))
    sizes = load_page_sizes(args.pdf)
    con = sqlite3.connect(db)
    rows = con.execute(QUERY, (args.item_key,)).fetchall()

    config = json.loads(Path(args.config).read_text(encoding="utf-8")) if Path(args.config).exists() else {}
    semantics = config.get("color_semantics", {})

    items, unmatched, with_comment = [], 0, 0
    for ann_key, ann_type, text, comment, color, page_label, position, modified, att_key, item_key, _ in rows:
        page_index, rects = None, []
        try:
            pos = json.loads(position or "{}")
            page_index = pos.get("pageIndex")
            rects = [[float(v) for v in r[:4]] for r in pos.get("rects", [])]
        except (ValueError, TypeError):
            pos = {}
        if page_index is None:
            unmatched += 1
            page_index = 0

        family = COLOR_MAP.get((color or "").lower(), "Gray")
        role = semantics.get(family, {}).get("role", "misc")
        weight = float(semantics.get(family, {}).get("weight", 0.3))
        if comment:
            with_comment += 1

        rects_norm = []
        if rects and page_index in sizes:
            w, h = sizes[page_index]
            for x0, y0, x1, y1 in rects:
                rects_norm.append([round(x0 / w, 4), round(1 - y1 / h, 4), round((x1 - x0) / w, 4), round((y1 - y0) / h, 4)])

        items.append({
            "key": ann_key,
            "type": TYPE_MAP.get(ann_type, "highlight"),
            "page_index": page_index,
            "page_label": page_label,
            "text": text or "",
            "comment": comment or "",
            "color": color or "",
            "color_category": family,
            "role": role,
            "weight": weight,
            "rects": rects,
            "rects_norm": rects_norm,
            "crop": None,
            "nodes": [],
            "primary": None,
            "unmatched": not bool(rects),
            "modified": modified,
        })

    stats = {
        "total": len(items),
        "highlight": sum(1 for x in items if x["type"] == "highlight"),
        "image": sum(1 for x in items if x["type"] == "image"),
        "note": sum(1 for x in items if x["type"] == "note"),
        "with_comment": with_comment,
        "no_geometry": unmatched,
        "unmatched": 0,
    }
    out = {
        "schema": "ann/1",
        "item_key": args.item_key,
        "attachment_key": rows[0][8] if rows else "",
        "generated": datetime.now().astimezone().isoformat(timespec="seconds"),
        "color_semantics": semantics,
        "items": items,
        "stats": stats,
    }
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "out": str(args.out), "stats": stats, "db": str(db)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
