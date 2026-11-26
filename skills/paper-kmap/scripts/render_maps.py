#!/usr/bin/env python3
"""Render .mmd files with mermaid-cli and verify the SVG is PowerPoint-safe."""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def mmdc_cmd() -> list[str]:
    exe = shutil.which("mmdc")
    if not exe:
        raise SystemExit("mmdc not found; npm i -g @mermaid-js/mermaid-cli")
    if exe.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", exe]
    return [exe]


def run(cmd: list[str]) -> tuple[int, str]:
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def check_svg(path: Path) -> dict:
    text = path.read_text(encoding="utf-8", errors="replace")
    return {
        "foreign_objects": text.count("foreignObject"),
        "has_viewbox": "viewBox" in text,
        "text_nodes": text.count("<text"),
        "bytes": path.stat().st_size,
    }


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--config", default=str(Path(__file__).resolve().parent.parent / "templates" / "mermaid.json"))
    ap.add_argument("--png", action="store_true")
    ap.add_argument("--size", type=int, default=1600)
    ap.add_argument("--scale", type=int, default=2)
    args = ap.parse_args()

    base = mmdc_cmd()
    work = Path(args.dir)
    report, failed = [], 0
    for src in sorted(work.glob("*.mmd")):
        svg = src.with_suffix(".svg")
        code, out = run(base + ["-i", str(src), "-o", str(svg), "-c", args.config, "-b", "white", "-q"])
        ok = svg.exists() and svg.stat().st_size > 200
        info = check_svg(svg) if ok else {}
        if not ok or info.get("foreign_objects") or not info.get("has_viewbox") or info.get("text_nodes", 0) == 0:
            failed += 1
            ok = False
        entry = {"file": src.name, "ok": ok, "svg": str(svg), **info, "log": out.strip()[-400:] if not ok else ""}
        if args.png:
            png = src.with_suffix(".png")
            run(base + ["-i", str(src), "-o", str(png), "-c", args.config, "-b", "white", "--size", str(args.size), "-s", str(args.scale), "-q"])
            entry["png"] = str(png) if png.exists() else None
        report.append(entry)

    (work / "render.log").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": failed == 0, "failed": failed, "report": report}, ensure_ascii=False, indent=2))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
