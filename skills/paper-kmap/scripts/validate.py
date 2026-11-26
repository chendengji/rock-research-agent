#!/usr/bin/env python3
"""Quality gates for a paper-kmap workspace. Exit 1 on errors."""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

KINDS = {"question", "gap", "method", "evidence", "claim", "mechanism", "limitation", "term", "user_note"}
RELS = {"supports", "contradicts", "refines", "requires", "part_of", "contrasts"}
PUNCT = re.compile(r"[\s\-–—_,.;:!?\"'“”‘’()\[\]{}<>/\\|·…]+")


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKC", text or "").lower()
    return PUNCT.sub("", text)


def load_json(path: Path):
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def load_pages(path: Path) -> dict[int, str]:
    pages = {}
    if not path.exists():
        return pages
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        pages[rec["page_index"]] = "\n".join(b.get("text", "") for b in rec.get("blocks", []))
    return pages


class Report:
    def __init__(self):
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.info: dict = {}

    def err(self, msg: str):
        self.errors.append(msg)

    def warn(self, msg: str):
        self.warnings.append(msg)

    def as_dict(self):
        return {"ok": not self.errors, "errors": self.errors, "warnings": self.warnings, "info": self.info}


def check_source(rep: Report, d: Path):
    pages = load_pages(d / "source" / "pages.jsonl")
    if not pages:
        rep.err("source/pages.jsonl missing or empty")
        return
    total = sum(len(v) for v in pages.values())
    rep.info["pages"] = len(pages)
    rep.info["chars_per_page"] = round(total / len(pages), 1)
    if total / len(pages) < 200:
        rep.err("text density < 200 chars/page; likely scanned -> run ingest_pdf.py OCR")
    # figures.json is an S2 product: warn (not err) so a source-only workspace is usable
    figp = d / "source" / "figures.json"
    if not figp.exists():
        rep.warn("source/figures.json missing (run figures_extract.py)")
    else:
        try:
            figs = json.loads(figp.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            rep.err("source/figures.json is not valid JSON")
            return
        if not isinstance(figs, list) or not figs:
            rep.warn("source/figures.json empty")
            return
        rep.info["figures"] = len(figs)
        nocap = [f.get("id") for f in figs if not f.get("caption")]
        if nocap:
            rep.warn(f"figures without caption: {nocap[:6]}")
        nocrop = [f.get("id") for f in figs if not f.get("crop")]
        if nocrop:
            rep.warn(f"figures not cropped ({len(nocrop)}): {nocrop[:6]}")


def check_kmap(rep: Report, d: Path, name="knowledge.v1.json"):
    k = load_json(d / name)
    if not k:
        rep.err(f"{name} missing")
        return None
    if k.get("schema") != "pkm/1":
        rep.err("bad schema tag")
    ids = [n.get("id") for n in k.get("nodes", [])]
    if len(ids) != len(set(ids)):
        rep.err("duplicate node ids")
    for n in k.get("nodes", []):
        if n.get("kind") not in KINDS:
            rep.err(f"{n.get('id')}: bad kind {n.get('kind')}")
        for field in ("text", "page", "quote"):
            if n.get(field) in (None, ""):
                rep.err(f"{n.get('id')}: missing {field}")
        imp = n.get("importance", 0)
        if not (0 <= float(imp) <= 1):
            rep.err(f"{n.get('id')}: importance out of range")
        if n.get("parent") and n["parent"] not in ids:
            rep.warn(f"{n.get('id')}: parent {n['parent']} not found")
    for e in k.get("edges", []):
        if e.get("rel") not in RELS:
            rep.err(f"bad edge rel {e.get('rel')}")
    rep.info["nodes"] = len(ids)
    return k


def check_budget(rep: Report, k: dict, cfg: dict):
    """渲染可读性预算（L1）：超限只 warn，不 block——认知层不许为凑预算删节点，
    超限在 S4 渲染层做聚合/分视图（见 core/maps.md 聚合、SKILL.md L47）。只有父子环是数据错误。"""
    if not k:
        return
    budget = cfg.get("budget", {})
    max_nodes = int(budget.get("max_nodes", 60))
    max_depth = int(budget.get("depth", 4))
    max_children = int(budget.get("children_per_node", 6))
    nodes = {n["id"]: n for n in k.get("nodes", [])}
    if len(nodes) > max_nodes:
        rep.warn(f"nodes {len(nodes)} > {max_nodes}（渲染层聚合，勿删认知层节点）")
    depth = {}

    def d_of(nid, seen=None):
        seen = seen or set()
        if nid in depth:
            return depth[nid]
        if nid in seen:
            rep.err(f"cycle at {nid}")
            return 0
        seen.add(nid)
        parent = nodes[nid].get("parent")
        val = 1 if not parent or parent not in nodes else d_of(parent, seen) + 1
        depth[nid] = val
        return val

    deepest = max((d_of(n) for n in nodes), default=0)
    rep.info["depth"] = deepest
    if deepest > max_depth:
        rep.warn(f"depth {deepest} > {max_depth}（渲染层聚合，勿删认知层节点）")
    counts: dict[str, int] = {}
    for n in nodes.values():
        if n.get("parent") in nodes:
            counts[n["parent"]] = counts.get(n["parent"], 0) + 1
    over = {k2: v for k2, v in counts.items() if v > max_children}
    if over:
        rep.warn(f"parents with > {max_children} children: {over}（渲染层聚合）")


def check_evidence(rep: Report, d: Path, k: dict):
    if not k:
        return
    pages = load_pages(d / "source" / "pages.jsonl")
    if not pages:
        rep.warn("no pages.jsonl; skip evidence check")
        return
    total = ok = 0
    missing = []
    for n in k.get("nodes", []):
        total += 1
        page = n.get("page")
        quote = n.get("quote", "")
        if page not in pages:
            missing.append(n["id"])
            continue
        hay = norm(pages[page])
        parts = [p for p in re.split(r"\s*…\s*", quote) if p.strip()]
        if parts and all(norm(p) in hay for p in parts):
            ok += 1
            n["verified"] = True
        else:
            missing.append(n["id"])
            n["verified"] = False
    rate = ok / total if total else 0
    rep.info.update({"evidence_total": total, "evidence_ok": ok, "evidence_rate": round(rate, 3)})
    if rate < 0.8:
        rep.err(f"evidence rate {rate:.0%} < 80%")
    elif rate < 0.95:
        rep.warn(f"evidence rate {rate:.0%} < 95%; unverified: {missing[:8]}")


def check_annotations(rep: Report, d: Path):
    a = load_json(d / "annotations.json")
    if not a:
        rep.err("annotations.json missing")
        return None
    items = a.get("items", [])
    stats = a.get("stats", {})
    rep.info["annotations"] = len(items)
    if stats.get("total") not in (None, len(items)):
        rep.warn("stats.total != len(items)")
    bad = [i["key"] for i in items if i.get("unmatched") and not i.get("unmatched_reason")]
    if bad:
        rep.err(f"unmatched without reason: {bad[:5]}")
    missing_crop = [i["key"] for i in items if i.get("type") == "image" and not i.get("crop")]
    if missing_crop:
        rep.warn(f"image annotations without crop: {len(missing_crop)}")
    no_geom = [i["key"] for i in items if not i.get("rects")]
    if no_geom:
        rep.warn(f"no geometry: {len(no_geom)}")
    return a


def check_refocus(rep: Report, d: Path, a: dict | None):
    v2 = load_json(d / "knowledge.v2.json")
    diff = load_json(d / "diff.v2.json")
    if not v2:
        rep.err("knowledge.v2.json missing")
        return
    if not diff:
        rep.err("diff.v2.json missing")
    else:
        c = diff.get("counts", {})
        if not any(c.get(k, 0) for k in ("added", "boosted", "removed", "merged")):
            rep.err("diff has no changes; refocus did not run")
    if a:
        v2_ids = {n["id"] for n in v2.get("nodes", [])}
        lost = [i["key"] for i in a["items"] if i.get("role") == "critical" and i.get("nodes") and not (set(i["nodes"]) & v2_ids)]
        if lost:
            rep.err(f"critical annotations lost in v2: {lost}")
        un = sum(1 for i in a["items"] if i.get("unmatched"))
        ratio = un / max(1, len(a["items"]))
        rep.info["unmatched_ratio"] = round(ratio, 3)
        if ratio > 0.1:
            rep.err(f"unmatched ratio {ratio:.0%} > 10%")


def check_deck(rep: Report, d: Path, a: dict | None):
    deck = load_json(d / "deck" / "deck.json")
    if not deck:
        rep.err("deck/deck.json missing")
        return
    slides = deck.get("slides", [])
    rep.info["slides"] = len(slides)
    if len(slides) < 3:
        rep.err("deck has < 3 slides")
    keys = {i["key"] for i in (a or {}).get("items", [])}
    for s in slides:
        if not s.get("notes"):
            rep.warn(f"{s.get('id')}: no speaker notes")
        fig = s.get("figure") or {}
        for rel in (fig.get("path"), s.get("image"), s.get("minimap")):
            if rel and not (d / rel).exists():
                rep.err(f"{s.get('id')}: missing asset {rel}")
        if s.get("annotation") and s["annotation"] not in keys:
            rep.err(f"{s.get('id')}: annotation {s['annotation']} not found")


def check_note(rep: Report, d: Path):
    n = load_json(d / "note" / "note.json")
    if not n:
        rep.err("note/note.json missing (run s7-note)")
        return
    if n.get("schema") != "note/1":
        rep.err("note.json bad schema tag")
    for field in ("takeaway", "reuse"):
        if not n.get(field):
            rep.warn(f"note.json missing {field} (should be my own words)")
    if not n.get("question", {}).get("text"):
        rep.err("note.json question.text missing")
    for r in n.get("results", []):
        rel = r.get("figure") or r.get("path")
        if rel and not (d / rel).exists():
            rep.err(f"note.json result figure missing: {rel}")
    rep.info["note_pages"] = n.get("pages", 2)


LEVELS = {"source", "kmap", "evidence", "budget", "annotations", "refocus", "deck", "note"}


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--paper-dir", default=".")
    ap.add_argument("--level", default="all", choices=sorted(LEVELS) + ["all"])
    ap.add_argument("--knowledge", default="knowledge.v1.json")
    ap.add_argument("--config", default=str(Path(__file__).resolve().parent.parent / "templates" / "kmap.config.json"))
    args = ap.parse_args()

    d = Path(args.paper_dir).resolve()
    cfg = load_json(Path(args.config)) or {}
    rep = Report()
    want = LEVELS if args.level == "all" else {args.level}

    k = None
    a = None
    if "source" in want:
        check_source(rep, d)
    if "kmap" in want or "evidence" in want or "budget" in want:
        k = check_kmap(rep, d, args.knowledge)
    if "budget" in want:
        check_budget(rep, k, cfg)
    if "evidence" in want:
        check_evidence(rep, d, k)
    if "annotations" in want or "refocus" in want or "deck" in want:
        a = check_annotations(rep, d) if (d / "annotations.json").exists() else None
    if "refocus" in want:
        check_refocus(rep, d, a)
    if "deck" in want:
        check_deck(rep, d, a)
    if "note" in want:
        check_note(rep, d)

    print(json.dumps(rep.as_dict(), ensure_ascii=False, indent=2))
    return 0 if not rep.errors else 1


if __name__ == "__main__":
    sys.exit(main())
