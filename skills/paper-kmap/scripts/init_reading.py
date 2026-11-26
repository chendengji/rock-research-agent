#!/usr/bin/env python3
"""Create the reading workspace for one paper and write manifest.json."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

SUBDIRS = ["source", "figs", "ann", "maps/v1", "maps/v2", "deck", "logs/llm"]


def default_lib() -> Path:
    env = os.environ.get("ROCK_PROJECT_ROOT")
    if env:
        return Path(env)
    return Path.home() / "Documents" / "literature-review"


def pdf_title(pdf: Path) -> str | None:
    """本地模式：从 PDF 第一页抽标题（PyMuPDF），失败回退文件名。"""
    try:
        import fitz
        doc = fitz.open(pdf)
        text = doc[0].get_text()[:400]
        doc.close()
        for line in text.splitlines():
            line = line.strip()
            if len(line) > 8:
                return line[:120]
    except Exception:
        pass
    return None


def parse_filename(stem: str) -> tuple[str, str, str]:
    """从文件名 `<年份> - <作者> - <标题>` 解析出 (year, author, title)。"""
    parts = [p.strip() for p in re.split(r"\s+-\s+", stem) if p.strip()]
    if len(parts) >= 3:
        return parts[0], parts[1], " - ".join(parts[2:])
    if len(parts) == 2:
        return "", parts[0], parts[1]
    return "", "", stem


def make_citekey(stem: str) -> str:
    """本地模式：从文件名生成短 citekey `<年份>-<一作>-<短标题>`。"""
    year, author, title = parse_filename(stem)
    a = re.sub(r"[^A-Za-z0-9\u4e00-\u9fff]+", "", author)[:8] or "anon"
    t = re.sub(r"[^A-Za-z0-9\u4e00-\u9fff]+", "", title)[:12] or "paper"
    y = re.sub(r"[^0-9]", "", year)[:4] or "na"
    return f"{y}-{a}-{t}"


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


def zotero_data_dir() -> Path:
    if os.environ.get("ZOTERO_DATA_DIR"):
        return Path(os.environ["ZOTERO_DATA_DIR"])
    for cand in (Path.home() / "Documents" / "Zotero", Path.home() / "Zotero"):
        if cand.exists():
            return cand
    return Path.home() / "Documents" / "Zotero"


def find_pdf(item_key: str, attachment_key: str | None, explicit: str | None) -> tuple[Path, str]:
    if explicit:
        p = Path(explicit).expanduser()
        if p.exists():
            return p, attachment_key or ""
        raise SystemExit(f"PDF not found: {p}")

    storage = zotero_data_dir() / "storage"
    keys = [attachment_key] if attachment_key else []
    if not keys:
        try:
            children = zotero_cli(["get", "children", item_key]).get("data", {}).get("items", [])
            keys = [c["key"] for c in children if c.get("itemType") == "attachment"]
        except Exception:
            keys = []
    for key in keys:
        pdfs = sorted((storage / key).glob("*.pdf"))
        if pdfs:
            return pdfs[0], key

    try:
        data = zotero_cli(["path", item_key]).get("data", {})
        text = data.get("text", "") if isinstance(data, dict) else ""
        match = re.search(r"Local path:\s*`([^`]+)`", text)
        if match:
            p = Path(match.group(1))
            if p.exists():
                return p, attachment_key or ""
    except Exception:
        pass

    raise SystemExit(f"cannot locate PDF for {item_key}; pass --pdf explicitly")


def sha1(path: Path) -> str:
    h = hashlib.sha1()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--item-key")  # Zotero 模式（批注回流 s5/s6）；与 --json/--pdf 二选一
    ap.add_argument("--attachment-key")
    ap.add_argument("--citekey")
    ap.add_argument("--json")   # 本地模式：paper-raw/<citekey>.json（解析文本，主要输入）
    ap.add_argument("--pdf")    # 本地模式可选（裁剪图/版面用）；Zotero 模式必填
    ap.add_argument("--lib", default=str(default_lib()))
    ap.add_argument("--link", action="store_true", help="soft/hard-link instead of copy")
    args = ap.parse_args()

    json_path = None
    pdf = None
    if args.item_key:
        # Zotero 模式：走 zotero-cli 取元数据与 PDF（s5 批注回流用）
        meta = zotero_cli(["get", "metadata", args.item_key]).get("data", {})
        title = meta.get("title") or args.item_key
        citekey = args.citekey or f"zotero-{args.item_key}"
        pdf, attach = find_pdf(args.item_key, args.attachment_key, args.pdf)
    else:
        # 本地模式：读文献库解析 JSON（paper-raw/<citekey>.json），不调 zotero-cli、不复制 PDF
        if not args.json and not args.pdf:
            raise SystemExit("需要 --item-key（Zotero 模式）或 --json/--pdf（本地模式）")
        if args.json:
            json_path = Path(args.json)
            if not json_path.exists():
                raise SystemExit(f"JSON 不存在：{json_path}")
            try:
                jd = json.loads(json_path.read_text(encoding="utf-8"))
                title = jd.get("title") or parse_filename(json_path.stem)[2]
            except Exception:
                title = parse_filename(json_path.stem)[2]
            citekey = args.citekey or make_citekey(json_path.stem)
        else:
            pdf = Path(args.pdf)
            if not pdf.exists():
                raise SystemExit(f"PDF 不存在：{pdf}")
            title = pdf_title(pdf) or pdf.stem
            citekey = args.citekey or make_citekey(pdf.stem)
        attach = ""
    paper_dir = Path(args.lib) / "paper-reading" / citekey
    for sub in SUBDIRS:
        (paper_dir / sub).mkdir(parents=True, exist_ok=True)

    # 不复制 PDF：本地模式只记路径（中间数据走 JSON/pages.jsonl）；Zotero 模式软链供批注几何/裁剪
    dest = paper_dir / "source" / "paper.pdf"
    pdf_copied = False
    if args.item_key and pdf and pdf.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            dest.unlink()
        try:
            os.link(pdf, dest)  # 软链，不复制
        except OSError:
            shutil.copy2(pdf, dest)
        pdf_copied = True

    manifest = {
        "schema": "manifest/1",
        "citekey": citekey,
        "item_key": args.item_key or "",
        "attachment_key": attach,
        "json": str(json_path) if json_path else "",
        "pdf": str(pdf) if pdf else "",
        "pdf_copied": pdf_copied,
        "title": title,
        "stage": "resolve",
        "done": ["resolve"],
        "counts": {"pages": 0, "nodes": 0, "figures": 0, "annotations": 0, "unmatched": 0},
        "annotations_seen": 0,
        "hashes": {"pdf_sha1": sha1(dest) if (args.item_key and pdf and pdf.exists()) else ""},
        "updated": datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    (paper_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "paper_dir": str(paper_dir), "pdf": str(dest), "citekey": citekey}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
