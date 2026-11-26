#!/usr/bin/env python3
"""Crop annotation regions to ann/<key>.png via zotero-cli read --rect."""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path


def zotero(args: list[str]) -> dict:
    proc = subprocess.run(["zotero-cli", "--json", *args], capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    out = (proc.stdout or "").strip()
    if not out:
        raise RuntimeError(proc.stderr.strip() or "zotero-cli returned nothing")
    return json.loads(out)


def expand(rect: list[float], margin: float) -> list[float]:
    x, y, w, h = rect
    x0, y0 = max(0.0, x - margin), max(0.0, y - margin)
    x1, y1 = min(1.0, x + w + margin), min(1.0, y + h + margin)
    return [round(x0, 4), round(y0, 4), round(x1 - x0, 4), round(y1 - y0, 4)]


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--paper-dir", default=".")
    ap.add_argument("--annotations", default="annotations.json")
    ap.add_argument("--margin", type=float, default=0.008)
    ap.add_argument("--all", action="store_true", help="crop highlights too (default: image only)")
    args = ap.parse_args()

    d = Path(args.paper_dir).resolve()
    apath = d / args.annotations
    data = json.loads(apath.read_text(encoding="utf-8"))
    att = data.get("attachment_key", "")
    ann_dir = d / "ann"
    ann_dir.mkdir(parents=True, exist_ok=True)

    done, failed = [], []
    for item in data.get("items", []):
        if item.get("type") != "image" and not args.all:
            continue
        rects = item.get("rects_norm") or []
        if not rects:
            failed.append({"key": item["key"], "why": "no rects_norm"})
            continue
        rect = expand(rects[0], args.margin)
        with tempfile.TemporaryDirectory(prefix="kmap-crop-") as tmp:
            try:
                res = zotero(["read", att, "--start-page", str(int(item["page_index"]) + 1),
                              "--format", "image", "--rect", ",".join(f"{v:.4f}" for v in rect), "--out", tmp])
                images = res.get("data", {}).get("images", [])
                if not images:
                    raise RuntimeError("no image produced")
                src = Path(images[0]["path"])
                dst = ann_dir / f"{item['key']}.png"
                dst.write_bytes(src.read_bytes())
                item["crop"] = f"ann/{dst.name}"
                done.append(item["key"])
            except Exception as exc:
                failed.append({"key": item["key"], "why": str(exc)[:200]})

    apath.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": not failed, "cropped": len(done), "failed": failed}, ensure_ascii=False, indent=2))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
