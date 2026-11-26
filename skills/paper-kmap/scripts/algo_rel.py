#!/usr/bin/env python3
"""Project an algorithm-relations flowchart from knowledge.json (adaptive).

自适应版：完全从 knowledge 的 nodes + edges 投影，不依赖任何固定节点 id 或分组。
LLM 自主归纳出 nodes（含 kind/text）+ edges（from/to/rel），本脚本只做投影：
  - 每个节点一个框，label = text；节点按 kind 上色
  - 每条边按 rel 区分线型/颜色并带 rel 标签
  - 不预设结构、不套模板——图型是 LLM 知识的直接投影

rel → (线型, 颜色) 映射（只作用于视觉，不改变知识）：
  refines       → 实线 蓝   （演化/改进）
  contrasts     → 虚线 灰   （对比/基准）
  requires      → 实线 橙   （依赖/前提）
  part_of       → 点线 绿   （组成/层级）
  supports      → 实线 紫   （支持证据）
  contradicts   → 虚线 红   （矛盾）
  其他          → 实线 灰
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# rel → (线型, 颜色名, 边标签显隐)
REL_STYLE = {
    "refines":     ("-->",  "#2b6cb0", True),
    "contrasts":   ("-.->", "#888888", True),
    "requires":    ("-->",  "#c05621", True),
    "part_of":     ("-.-",  "#2f855a", True),
    "supports":    ("-->",  "#6b46c1", True),
    "contradicts": ("-.->", "#c53030", True),
}
KIND_COLOR = {
    "method":     "#2b6cb0",
    "claim":      "#2f855a",
    "evidence":   "#6b46c1",
    "limitation": "#c53030",
    "question":   "#c05621",
    "gap":        "#c05621",
    "term":       "#4a5568",
    "mechanism":  "#2b6cb0",
    "user_note":  "#718096",
}


def esc(s: str) -> str:
    return s.replace('"', "'").replace("[", "(").replace("]", ")")


def _clean(text: str, limit: int) -> str:
    import re
    text = re.sub(r"\s+", " ", (text or "").strip())
    if len(text) <= limit:
        return text
    head = text[: limit - 1]
    for sep in ("，", ",", "；", ";", "、", " "):
        cut = head.rfind(sep)
        if cut >= limit // 2:
            return head[:cut] + "…"
    return head + "…"


def _wrap2(label: str, per_line: int) -> list[str]:
    if len(label) <= per_line:
        return [label]
    cut = -1
    for sep in ("，", ",", "；", ";", "、", " ", "–", "－"):
        pos = label.rfind(sep, 0, per_line + 4)
        cut = max(cut, pos)
    if cut < per_line // 2:
        space = label.rfind(" ", 0, per_line)
        cut = space if space > 0 else per_line - 1
    first, second = label[: cut + 1], label[cut + 1:]
    first = first.rstrip("，,；;、–－ ")
    second = second.lstrip("，,；;、–－ ")
    return [first, second] if second else [first]


def label(text: str, limit: int = 40, per_line: int = 20) -> str:
    """Escaped label, explicit <br/> line breaks, cut at natural boundary."""
    return "<br/>".join(esc(x) for x in _wrap2(_clean(text, limit), per_line))


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--knowledge", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--all", action="store_true", help="画全部节点（含无关系边的孤立节点）；默认只画参与关系边的")
    args = ap.parse_args()

    k = json.loads(Path(args.knowledge).read_text(encoding="utf-8"))
    nodes = {n["id"]: n for n in k.get("nodes", [])}
    edges = k.get("edges", [])

    # 关系网络：默认只画参与关系边的节点（孤立细节交给 mindmap/tree）；--all 画全部
    related = set()
    for e in edges:
        related.add(e.get("from"))
        related.add(e.get("to"))
    show_ids = set(nodes) if args.all else (related & set(nodes))
    if not show_ids:
        show_ids = set(nodes)

    lines = ["flowchart LR"]
    # 每个 kind 一个 classDef
    lines.append('  classDef method fill:#eef4fb,stroke:#2b6cb0,stroke-width:1.5px,color:#1a3a5c')
    lines.append('  classDef claim fill:#f0f7f0,stroke:#2f855a,stroke-width:1.5px,color:#1a3a2c')
    lines.append('  classDef evidence fill:#f5f0fb,stroke:#6b46c1,stroke-width:1.5px,color:#3a2a5c')
    lines.append('  classDef limitation fill:#fdf0f0,stroke:#c53030,stroke-width:1.5px,color:#5c1a1a')
    lines.append('  classDef question fill:#fdf4ec,stroke:#c05621,stroke-width:1.5px,color:#5c2a0a')
    lines.append('  classDef term fill:#f7f7f7,stroke:#4a5568,stroke-width:1px,color:#333333')
    lines.append('  classDef other fill:#f7f7f7,stroke:#b0b0b0,stroke-width:1px,color:#444444')

    used = {}
    for nid, n in nodes.items():
        if nid not in show_ids:
            continue
        used[nid] = f"N{nid}"
        lab = label(n.get("text", ""))
        lines.append(f'  {used[nid]}["{lab}"]')

    # 边：按 rel 投影（自适应，无固定结构）；只画两端都在显示集内的
    rels_seen = {}
    for e in edges:
        f, t = e.get("from"), e.get("to")
        if f not in used or t not in used:
            continue
        rel = e.get("rel", "supports")
        arrow, color, show_tag = REL_STYLE.get(rel, ("-->", "#888888", False))
        tag = f'|{rel}|' if show_tag else ""
        lines.append(f'  {used[f]} {arrow}{tag} {used[t]}')
        rels_seen[rel] = rels_seen.get(rel, 0) + 1

    # 节点上色：按 kind
    for nid, n in nodes.items():
        if nid not in used:
            continue
        kind = n.get("kind", "other")
        cls = kind if kind in KIND_COLOR else "other"
        lines.append(f'  class {used[nid]} {cls}')

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "out": str(out), "nodes": len(used),
                      "edges": len(edges), "rels": rels_seen}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
