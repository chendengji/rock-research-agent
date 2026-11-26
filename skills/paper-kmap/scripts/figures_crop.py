#!/usr/bin/env python3
"""Crop each figure in source/figures.json to figs/Fn.png via zotero-cli read.

Reads the cleaned figures list (figures_extract.py) and, for every record,
calls `zotero-cli read <ATT> --start-page <page> --format image --rect <bbox>`,
then writes figs/F<n>.png and backfills the `crop` field back to the JSON.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def zotero(args: list[str]) -> dict:
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    proc = subprocess.run(["zotero-cli", "--json", *args], capture_output=True, env=env)
    raw = proc.stdout or b""
    if not raw.strip():
        raise RuntimeError(f"zotero-cli failed: {' '.join(args)}\n{proc.stderr!r}")
    for enc in ("utf-8", "gbk"):
        try:
            return json.loads(raw.decode(enc))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
    raise RuntimeError(f"cannot parse zotero-cli output: {raw[:200]!r}")


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--attachment-key", required=True)
    ap.add_argument("--paper-dir", default=".")
    ap.add_argument("--figures", default="source/figures.json")
    args = ap.parse_args()

    d = Path(args.paper_dir).resolve()
    fpath = d / args.figures
    figures = json.loads(fpath.read_text(encoding="utf-8"))
    figs_dir = d / "figs"
    figs_dir.mkdir(parents=True, exist_ok=True)

    done, failed, skipped = [], [], []
    for fig in figures:
        if fig.get("crop"):
            skipped.append({"id": fig["id"], "crop": fig["crop"]})
            continue
        rect = fig.get("rect_arg") or ",".join(f"{v:.4f}" for v in fig["bbox"])
        with tempfile.TemporaryDirectory(prefix="kmap-fig-") as tmp:
            try:
                res = zotero(["read", args.attachment_key, "--start-page", str(fig["page"]),
                              "--format", "image", "--rect", rect, "--out", tmp])
                images = (res.get("data") or {}).get("images", [])
                if not images:
                    raise RuntimeError("no image produced")
                dst = figs_dir / f"{fig['id']}.png"
                dst.write_bytes(Path(images[0]["path"]).read_bytes())
                fig["crop"] = f"figs/{dst.name}"
                done.append({"id": fig["id"], "crop": fig["crop"]})
            except Exception as exc:
                failed.append({"id": fig["id"], "why": str(exc)[:200]})

    fpath.write_text(json.dumps(figures, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": not failed, "cropped": len(done), "skipped": len(skipped),
                      "failed": failed}, ensure_ascii=False, indent=2))
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
