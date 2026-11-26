#!/usr/bin/env python3
"""Annotation-driven refocus: v1 -> v2 (+ diff). Deterministic; no LLM needed."""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from difflib import SequenceMatcher
from pathlib import Path

PUNCT = re.compile(r"[\s\-–—_,.;:!?\"'“”‘’()\[\]{}<>/\\|·…]+")


def norm(text: str) -> str:
    return PUNCT.sub("", unicodedata.normalize("NFKC", text or "").lower())


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def load_pages(path: Path) -> dict[int, dict]:
    pages = {}
    if not path.exists():
        return pages
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            rec = json.loads(line)
            pages[rec["page_index"]] = rec
    return pages


def overlap(a: list[float], b: list[float]) -> float:
    if not (a and b and len(a) == 4 and len(b) == 4):
        return 0.0
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    inter = (x1 - x0) * (y1 - y0)
    areas = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / areas if areas > 0 else 0.0


def to_topleft(rect: list[float], height: float) -> list[float]:
    x0, y0, x1, y1 = rect
    return [x0, height - y1, x1, height - y0]


def similarity(a: str, b: str) -> float:
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 1.0
    if len(a) > 900 or len(b) > 900:
        a, b = a[:900], b[:900]
    return SequenceMatcher(None, a, b).ratio()


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--paper-dir", default=".")
    ap.add_argument("--knowledge", default="knowledge.v1.json")
    ap.add_argument("--annotations", default="annotations.json")
    ap.add_argument("--out", default="knowledge.v2.json")
    ap.add_argument("--diff", default="diff.v2.json")
    ap.add_argument("--config", default=str(Path(__file__).resolve().parent.parent / "templates" / "kmap.config.json"))
    args = ap.parse_args()

    d = Path(args.paper_dir).resolve()
    k = load_json(d / args.knowledge)
    a = load_json(d / args.annotations)
    if not k or not a:
        raise SystemExit("need knowledge.v1.json and annotations.json")
    cfg = load_json(Path(args.config)) or {}
    refocus = cfg.get("refocus", {})
    threshold = float(refocus.get("threshold", 0.35))
    keep_top = int(refocus.get("keep_top", 55))
    sim_th = float(refocus.get("text_similarity", 0.75))

    pages = load_pages(d / "source" / "pages.jsonl")
    nodes = [dict(n) for n in k.get("nodes", [])]
    by_id = {n["id"]: n for n in nodes}
    for n in nodes:
        n["importance_v1"] = float(n.get("importance", 0.4))
    next_id = max([int(re.sub(r"\D", "", n["id"]) or 0) for n in nodes] + [0]) + 1

    added, boosted, demoted, removed, merged = [], [], [], [], []
    used = set()

    for ann in a.get("items", []):
        page = ann.get("page_index")
        rec = pages.get(page, {})
        height = float(rec.get("height", 842.0))
        width = float(rec.get("width", 595.0))
        rect_tl = [to_topleft(r, height) for r in ann.get("rects", [])]

        best: list[tuple[float, dict]] = []
        for n in nodes:
            sim = similarity(ann.get("text", ""), n.get("quote", "")) if ann.get("text") else 0.0
            ov = max([overlap(r, n.get("bbox") or []) for r in rect_tl] or [0.0]) if n.get("bbox") else 0.0
            if n.get("page") == page and (sim >= sim_th or ov > 0.15):
                best.append((max(sim, ov), n))
        best.sort(key=lambda x: -x[0])
        targets = [n for s, n in best if s >= min(sim_th, 0.15)][:3]

        # a framed figure/table is the user pointing at a picture, not a sentence
        figure_hit = None
        if rect_tl and ann.get("type") in ("image", "ink"):
            for fig in k.get("figures", []):
                if fig.get("page") != page or not fig.get("bbox"):
                    continue
                fx, fy, fw, fh = fig["bbox"]
                frect = [fx * width, fy * height, (fx + fw) * width, (fy + fh) * height]
                ov = max(overlap(r, frect) for r in rect_tl)
                if ov > 0.3 and (figure_hit is None or ov > figure_hit[0]):
                    figure_hit = (ov, fig)

        if not targets:
            nid = f"N{next_id:02d}"
            next_id += 1
            text = (ann.get("text") or "").strip()
            if figure_hit:
                label = "图注：" + (figure_hit[1].get("label") or "图表")
            elif text:
                label = "批注：" + ((text[:34] + "…") if len(text) > 34 else text)
            else:
                label = f"框选批注 p.{int(page or 0) + 1}"
            # keep the tree coherent: hang the new node under the strongest node of its page
            siblings = [n for n in nodes if n.get("page") == page and n["id"] != nid]
            parent_id = max(siblings, key=lambda n: float(n.get("importance_v1", 0)))["id"] if siblings else None
            node = {
                "id": nid, "kind": "evidence" if figure_hit else "user_note", "section": None,
                "text": label, "detail": ann.get("comment", ""),
                "page": page, "quote": text or "[image annotation]",
                "bbox": rect_tl[0] if rect_tl else None,
                "importance": float(ann.get("weight", 0.5)),
                "importance_v1": 0.0, "parent": parent_id,
                "tags": ["annotation"], "from_annotation": ann["key"],
                "figures": [figure_hit[1]["id"]] if figure_hit else [],
            }
            nodes.append(node)
            by_id[nid] = node
            targets = [node]
            why = f"批注 {ann['key']} 未匹配到 v1 节点"
            if figure_hit:
                why += f"；与 {figure_hit[1]['id']} 区域重叠，按图注建节点"
            added.append({"id": nid, "text": label, "why": why})

        ann["nodes"] = [n["id"] for n in targets]
        ann["primary"] = targets[0]["id"]
        ann["unmatched"] = False
        for n in targets:
            n.setdefault("annotations", [])
            if ann["key"] not in n["annotations"]:
                n["annotations"].append(ann["key"])
            used.add(n["id"])

    # scoring
    weights = {i["key"]: float(i.get("weight", 0.5)) for i in a.get("items", [])}
    comments = {i["key"]: bool(i.get("comment")) for i in a.get("items", [])}
    roles = {i["key"]: i.get("role", "general") for i in a.get("items", [])}

    for n in nodes:
        keys = n.get("annotations", [])
        if keys:
            w = max(weights.get(x, 0.5) for x in keys)
            bonus = min(0.15, 0.05 * (len(keys) - 1))
            cb = 0.10 if any(comments.get(x) for x in keys) else 0.0
            score = min(1.0, w + bonus + cb)
            n["importance"] = round(0.35 * n.get("importance_v1", 0.4) + 0.65 * score, 2)
            n["hot"] = True
            n["hot2"] = any(roles.get(x) == "critical" for x in keys) or any(comments.get(x) for x in keys)
            boosted.append({"id": n["id"], "from": n.get("importance_v1"), "to": n["importance"], "why": f"{len(keys)} 条批注，最高权重 {w}"})
        else:
            n["importance"] = round(n.get("importance_v1", 0.4) * 0.75, 2)
            n["hot"] = False
            n["hot2"] = False
            if n.get("importance_v1", 0) - n["importance"] > 0.05:
                demoted.append({"id": n["id"], "from": n.get("importance_v1"), "to": n["importance"], "why": "未被批注，整体降温"})

    # protected set: annotated + ancestors
    parent = {n["id"]: n.get("parent") for n in nodes}
    protected = set()
    for nid in used:
        cur, guard = nid, 0
        while cur and guard < 20:
            protected.add(cur)
            cur = parent.get(cur)
            guard += 1

    # prune unprotected leaves
    alive = {n["id"]: n for n in nodes}
    changed = True
    while changed:
        changed = False
        children = {}
        for n in alive.values():
            if n.get("parent") in alive:
                children.setdefault(n["parent"], []).append(n["id"])
        for nid, n in list(alive.items()):
            if nid in protected or children.get(nid):
                continue
            if n.get("kind") in ("gap", "limitation"):
                continue
            if n["importance"] < threshold:
                alive.pop(nid)
                removed.append({"id": nid, "text": n.get("text", ""), "why": f"未批注且 {n['importance']} < {threshold}"})
                changed = True

    # cap
    if len(alive) > keep_top:
        removable = sorted(
            [n for n in alive.values() if n["id"] not in protected and n.get("kind") not in ("gap", "limitation")],
            key=lambda n: n["importance"],
        )
        for n in removable[: len(alive) - keep_top]:
            alive.pop(n["id"], None)
            removed.append({"id": n["id"], "text": n.get("text", ""), "why": f"超出 keep_top={keep_top}"})

    # expand empty details of annotated nodes
    for nid in used:
        n = alive.get(nid)
        if not n or n.get("detail"):
            continue
        rec = pages.get(n.get("page"))
        if not rec:
            continue
        blocks = rec.get("blocks", [])
        if not blocks:
            continue
        idx = min(range(len(blocks)), key=lambda i: abs(blocks[i]["bbox"][1] - (n.get("bbox") or [0, 0])[1]))
        ctx = [blocks[j]["text"].strip() for j in (idx - 1, idx + 1) if 0 <= j < len(blocks)]
        if ctx:
            n["detail"] = ("上下文：" + " ".join(ctx))[:300]

    # rebuild parent links + edges
    v2_nodes = []
    for n in nodes:
        if n["id"] not in alive:
            continue
        n = dict(n)
        if n.get("parent") not in alive:
            n["parent"] = None
        v2_nodes.append(n)

    alive_ids = {n["id"] for n in v2_nodes}
    v2 = dict(k)
    v2["nodes"] = v2_nodes
    v2["edges"] = [e for e in k.get("edges", []) if e.get("from") in alive_ids and e.get("to") in alive_ids]
    v2["focus"] = {
        "mode": "annotation", "version": "v2", "source": args.annotations,
        "threshold": threshold, "keep_top": keep_top,
        "annotated_nodes": len(used),
    }

    counts = {
        "nodes_v1": len(k.get("nodes", [])), "nodes_v2": len(v2_nodes),
        "added": len(added), "boosted": len(boosted), "demoted": len(demoted),
        "removed": len(removed), "merged": len(merged),
    }
    diff = {"schema": "diff/1", "from": "v1", "to": "v2", "counts": counts,
            "added": added, "boosted": boosted, "demoted": demoted, "removed": removed, "merged": merged}

    un = sum(1 for i in a.get("items", []) if i.get("unmatched"))
    a.setdefault("stats", {})["unmatched"] = un

    (d / args.out).write_text(json.dumps(v2, ensure_ascii=False, indent=2), encoding="utf-8")
    (d / args.diff).write_text(json.dumps(diff, ensure_ascii=False, indent=2), encoding="utf-8")
    (d / "annotations.json").write_text(json.dumps(a, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "counts": counts, "unmatched": un,
                      "annotated_nodes": len(used)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
