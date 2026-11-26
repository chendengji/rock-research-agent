#!/usr/bin/env python3
"""Render knowledge.json into three Mermaid sources (no LLM, no hand layout)."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

BAD = re.compile(r"[\[\]{}|]")  # 标签都在 ["..."] 引号内，括号 () 安全；mindmap 裸文本另删

# ---- 数值感知断行/截断（避免切断数字、数字区间、单位、括号等原子） ----
# 原子：数字区间(90–100)、数值+单位(20MPa/0.5%/0.03%)、科学计数、括号整体（含中文括号）、σ比值
ATOM = re.compile(
    r"(?:\d+(?:\.\d+)?\s*[–\-~～至]\s*\d+(?:\.\d+)?)"   # 数字区间 90–100, 1.0–1.2, 10–20%
    r"|(?:[-–]?\d+(?:\.\d+)?(?:e[+-]?\d+)?\s*(?:%|MPa|kPa|GPa|mm|cm|m|kN|MN|N|kJ|MJ|GJ|s|Hz|°)?)"  # 数值+可选单位（含负号）
    r"|(?:[（(][^（）()]*[）)])"                                 # 括号整体（中文/英文）
    r"|(?:σ\d+\s*/\s*σ\d+)"                                  # σ3/σ1
)


def _atom_spans(text: str) -> list[tuple[int, int]]:
    """返回不可断原子区间 [(start,end), ...]。"""
    return [(m.start(), m.end()) for m in ATOM.finditer(text)]


def _breakable(text: str) -> list[int]:
    """返回所有可断点索引（在原子之间、非原子内部、非英文单词内部、非负号前）。断点 i 表示 text[:i] | text[i:]。"""
    spans = _atom_spans(text)
    ok = []
    for i in range(1, len(text)):
        if any(s < i < e for s, e in spans):
            continue  # 在原子内部，不可断
        # 英文单词内部不可断（词边界断行）
        if text[i - 1].isalpha() and text[i].isalpha():
            continue
        # 负号前缀：-5MPa 的 '-' 不能与数值分开
        if text[i] == "-" and i + 1 < len(text) and text[i + 1].isdigit():
            continue
        if text[i - 1] == "-" and text[i].isdigit():
            continue
        ok.append(i)
    return ok


def _nearest_break(text: str, per_line: int, window: int = 8) -> int:
    """在 per_line 附近 ±window 找最近可断点；找不到回退 per_line（尽量不切原子）。"""
    ok = _breakable(text)
    if not ok:
        return max(1, per_line)
    cand = [b for b in ok if abs(b - per_line) <= window]
    if cand:
        return min(cand, key=lambda b: abs(b - per_line))
    # 无窗口内断点：取左侧最近可断点；无则右侧最近
    left = [b for b in ok if b < per_line]
    if left:
        return max(left)
    right = [b for b in ok if b > per_line]
    return min(right) if right else max(1, per_line)
# five slide-friendly tiers: (label, kinds merged into that tier)
TIERS = [
    ("问题", ["question"]),
    ("Gap", ["gap"]),
    ("方法/证据", ["method", "evidence"]),
    ("结论", ["claim", "mechanism"]),
    ("局限", ["limitation"]),
]


def clean(text: str, limit: int = 1000) -> str:
    """Normalize a label for Mermaid: collapse whitespace, strip BAD chars, smart quotes.

    不做字符截断（去掉 …）：文本完整保留，由 Mermaid 按 flowchart.wrappingWidth 自动换行，
    避免主动截断丢失关键信息（如 "（fos<1）"、章节全名）。
    limit 参数保留仅供调用方兼容，不再参与截断。
    """
    text = re.sub(r"\s+", " ", (text or "").strip())
    return BAD.sub("", text).replace('"', "”")


def wrap2(label: str, per_line: int) -> list[str]:
    """Break a label into at most two lines on a natural boundary (never mid-number/unit)."""
    if len(label) <= per_line:
        return [label]
    cut = _nearest_break(label, per_line)
    first, second = label[:cut], label[cut:]
    # 不剥 '-'（可能是负号/减号），只剥分隔符与区间连字符
    first = first.rstrip("，,；;、–－ ")
    second = second.lstrip("，,；;、–－ ")
    return [first, second] if second else [first]


def mlabel(text: str, limit: int = 40, per_line: int = 20) -> str:
    """Escaped mermaid label on ONE line (no explicit <br/>).

    Mermaid 渲染 PNG/SVG 时按 flowchart.wrappingWidth（默认 300px）自动换行，
    主动 <br/> 会与自动换行叠加，导致图中文字多出不必要的断行。
    因此这里只做截断（clean）防止超长文本，不做主动断行。
    per_line 参数保留仅供调用方兼容，不再参与断行。
    """
    return esc(clean(text, limit))


def node_label(node: dict, limit: int = 40, per_line: int = 20) -> str:
    return ("★" if node.get("hot") else "") + mlabel(node.get("text", ""), limit, per_line)


def esc(label: str) -> str:
    return label.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_tree(nodes: list[dict]) -> tuple[list[dict], dict[str, list[dict]]]:
    ids = {n["id"] for n in nodes}
    children: dict[str, list[dict]] = {}
    roots = []
    for n in nodes:
        parent = n.get("parent")
        if parent and parent in ids and parent != n["id"]:
            children.setdefault(parent, []).append(n)
        else:
            roots.append(n)
    for k in children:
        children[k].sort(key=lambda x: -float(x.get("importance", 0)))
    roots.sort(key=lambda x: -float(x.get("importance", 0)))
    return roots, children


def render_mindmap(k: dict, cfg: dict) -> str:
    budget = cfg.get("budget", {})
    branches = int(budget.get("mindmap_branches", 6))
    per_node = int(budget.get("children_per_node", 6))
    roots, children = build_tree(k.get("nodes", []))
    title = clean(k.get("meta", {}).get("short_title") or k.get("meta", {}).get("title", "Paper"), 36)
    lines = ["mindmap", f"  root(({esc(title)}))"]

    def walk(node: dict, depth: int) -> None:
        # mindmap renders <br/> as an empty box, so keep every label on one line
        # 裸文本：括号 () 会破坏 mindmap 解析，单独删（tree/flow 在引号内可保留）
        text = ("★" if node.get("hot") else "") + clean(node.get("text", ""), 40).replace("(", "").replace(")", "")
        lines.append("    " * depth + esc(text))
        for kid in children.get(node["id"], [])[:per_node]:
            walk(kid, depth + 1)

    for root in roots[:branches]:
        walk(root, 2)
    return "\n".join(lines) + "\n"


def render_timeline(k: dict, cfg: dict) -> str:
    """时间脉络图（综述/研究现状）：Mermaid timeline 原生语法。

    输入 knowledge.json 的 timeline.events[{year,label,text}]；无 events 返回空串（不产出）。
    用于综述/研究背景类：按年份/阶段展开领域进展，看历史脉络。
    """
    tl = k.get("timeline") or {}
    events = tl.get("events", []) or []
    if not events:
        return ""
    title = clean(tl.get("title") or k.get("meta", {}).get("short_title") or k.get("meta", {}).get("title", "时间脉络"), 40)
    lines = ["timeline", f"    title {esc(title)}"]
    for ev in events:
        year = str(ev.get("year", ""))
        label = clean(str(ev.get("label", "")), 30).replace(":", "，")
        text = clean(str(ev.get("text", "")), 60).replace(":", "，")
        if year:
            if label and text:
                lines.append(f"    {year} : {label} : {text}")
            elif label:
                lines.append(f"    {year} : {label}")
            else:
                lines.append(f"    {year} : {text}")
    return "\n".join(lines) + "\n"


def render_tree(k: dict, cfg: dict) -> str:
    """论文结构树（思维导图主产出）：标题 → 章节(outline) → 一级节点 → 子节点。

    横向 LR，把论文结构展开成树状分层，一看就懂：章节即骨架，节点即要点。
    不是论证阶梯（那是 render_hierarchy），而是论文本身的章节结构。
    """
    budget = cfg.get("budget", {})
    per_node = int(budget.get("tree_children", 11))  # 知识框架分支（如 11 类指标）需全显，比 children_per_node 宽
    per_section = int(budget.get("tree_per_section", 4))
    nodes = k.get("nodes", [])
    outline = k.get("outline", []) or []
    meta = k.get("meta", {})
    roots, children = build_tree(nodes)
    title = clean(meta.get("short_title") or meta.get("title", meta.get("citekey", "Paper")), 36)

    lines = ["graph LR", f'  T0["{mlabel(title, 36, 18)}"]']
    counter = 0

    def nid() -> str:
        nonlocal counter
        counter += 1
        return f"T{counter}"

    # 一级节点按归属章节分组；无章节归属的孤儿直接挂标题
    sec_roots: dict[str, list] = {}
    orphan = []
    for r in roots:
        if r.get("section"):
            sec_roots.setdefault(r["section"], []).append(r)
        else:
            orphan.append(r)

    def add_branch(parent_sid: str, root: dict, depth: int = 0) -> None:
        if depth > int(budget.get("depth", 4)):
            return
        rid = nid()
        lines.append(f'  {rid}["{node_label(root, 40, 20)}"]')
        lines.append(f'  {parent_sid} --> {rid}')
        for kid in children.get(root["id"], [])[:per_node]:
            add_branch(rid, kid, depth + 1)

    # 孤儿一级节点（未分节）直接挂根
    for r in orphan[:per_section * 2]:
        add_branch("T0", r)

    # 章节节点：标题 → 章节 → 该节一级节点 → 子节点
    for s in outline:
        sid = nid()
        lines.append(f'  {sid}["{mlabel(s.get("title", ""), 30, 15)}"]')
        lines.append(f'  T0 --> {sid}')
        for r in sec_roots.get(s.get("id"), [])[:per_section]:
            add_branch(sid, r)

    return "\n".join(lines) + "\n"


def render_hierarchy(k: dict, cfg: dict) -> str:
    """Argument ladder in five tiers: 问题 → Gap → 方法/证据 → 结论 → 局限.

    Five tiers keep the aspect ratio near 16:9. Six ranks rendered top-down turn
    into a portrait strip; rendered left-right they turn into a 6:1 sliver, and
    neither is projectable.
    """
    nodes = k.get("nodes", [])
    by_kind: dict[str, list[dict]] = {}
    for n in nodes:
        by_kind.setdefault(n.get("kind", "evidence"), []).append(n)
    for kind in by_kind:
        by_kind[kind].sort(key=lambda x: -float(x.get("importance", 0)))

    tiers: list[tuple[str, list[dict]]] = []
    for label, kinds in TIERS:
        pool: list[dict] = []
        for kind in kinds:
            pool.extend(by_kind.get(kind, []))
        pool.sort(key=lambda x: -float(x.get("importance", 0)))
        if pool:
            tiers.append((label, pool[:3]))
    if not tiers:
        tiers = [("证据", nodes[:3])]

    ids: dict[str, str] = {}
    lines = ["graph TD"]
    counter = 0
    for label, group in tiers:
        for node in group:
            counter += 1
            nid = f"R{counter}"
            ids[node["id"]] = nid
            lines.append(f'  {nid}["{label}<br/>{node_label(node, 40, 20)}"]')
    for li in range(1, len(tiers)):
        prev = [ids[n["id"]] for n in tiers[li - 1][1] if n["id"] in ids]
        for node in tiers[li][1]:
            cur = ids[node["id"]]
            if prev:
                lines.append(f"  {prev[0]} --> {cur}")

    # explicit argument edges (tree/part_of links are structure, not arguments)
    for edge in k.get("edges", []):
        if edge.get("rel") == "part_of":
            continue
        a, b = ids.get(edge.get("from")), ids.get(edge.get("to"))
        if a and b and a != b:
            lines.append(f"  {a} -.->|{edge.get('rel', 'rel')}| {b}")

    hot = [ids[n["id"]] for n in nodes if n.get("hot2") is False and n.get("hot") and n["id"] in ids]
    hot2 = [ids[n["id"]] for n in nodes if n.get("hot2") and n["id"] in ids]
    lines += [
        "  classDef hot fill:#ffe9a8,stroke:#e0a800,stroke-width:2.5px,color:#3a2a00",
        "  classDef hot2 fill:#ffd0a8,stroke:#d2691e,stroke-width:3px,color:#3a2a00",
    ]
    plain = sorted(set(hot) - set(hot2))
    if plain:
        lines.append("  class " + ",".join(plain) + " hot")
    if hot2:
        lines.append("  class " + ",".join(sorted(set(hot2))) + " hot2")
    return "\n".join(lines) + "\n"


def render_flow(k: dict, cfg: dict) -> tuple[str, int]:
    """Method chain. Only explicit `flow.stages` counts: a review's method nodes
    are topics, not a sequence, and stringing them together invents a workflow.

    两种模式（按需，不强制）：
    - 线性链：flow.stages = [{step, io, hot}, ...]，P1-->P2 单线串接；
    - 显式图（分支/条件/并行/汇合）：flow.graph = {nodes:[{id,label,io,shape,hot}],
      edges:[{from,to,label}]}；shape=rect|diamond（条件判断菱形）。
      有 graph.nodes 走图模式，否则退回线性链。
    """
    flow = k.get("flow") or {}
    g = flow.get("graph")
    if g and g.get("nodes"):
        return render_flow_graph(g, cfg), len(g["nodes"])
    stages = flow.get("stages") or []
    stages = stages[: int(cfg.get("budget", {}).get("flow_steps", 9))]
    if not stages:
        return 'flowchart LR\n  P0["无方法链<br/>（综述类论文可留空）"]\n', 0

    lines = ["flowchart LR", "  classDef hot fill:#ffe9a8,stroke:#e0a800,stroke-width:2.5px,color:#3a2a00"]
    for i, st in enumerate(stages):
        nid = f"P{i+1}"
        label = mlabel(st.get("step") or st.get("label", ""), 40, 20)
        if st.get("io"):
            label += "<br/>" + mlabel(st["io"], 30, 15)
        lines.append(f'  {nid}["{label}"]')
    for i in range(len(stages) - 1):
        lines.append(f"  P{i+1} --> P{i+2}")
    hot = [f"P{i+1}" for i, st in enumerate(stages) if st.get("hot")]
    if hot:
        lines.append("  class " + ",".join(hot) + " hot")
    return "\n".join(lines) + "\n", len(stages)


def render_flow_graph(g: dict, cfg: dict) -> str:
    """显式图：分支/条件判断（菱形）/并行/汇合。
    nodes: [{id, label, io?, shape?=rect|diamond, hot?}]
    edges: [{from, to, label?}]  label 为边文字（如 yes/no/条件）。
    """
    lines = ["flowchart LR", "  classDef hot fill:#ffe9a8,stroke:#e0a800,stroke-width:2.5px,color:#3a2a00",
             "  classDef cond fill:#e8f0fe,stroke:#3a6ea5,stroke-width:2px,color:#123a6e"]
    for n in g.get("nodes", []):
        nid = str(n["id"])
        label = mlabel(n.get("label", ""), 40, 20)
        if n.get("io"):
            label += "<br/>" + mlabel(n["io"], 30, 15)
        label = label.replace("}", "").replace("{", "")
        shape = n.get("shape", "rect")
        if shape == "diamond":
            lines.append(f'  {nid}{{{{{label}}}}}')
        else:
            lines.append(f'  {nid}["{label}"]')
    for e in g.get("edges", []):
        el = f'|{e["label"]}|' if e.get("label") else ""
        lines.append(f'  {e["from"]} -->{el} {e["to"]}')
    hot = [str(n["id"]) for n in g.get("nodes", []) if n.get("hot")]
    if hot:
        lines.append("  class " + ",".join(hot) + " hot")
    return "\n".join(lines) + "\n"


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--knowledge", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--config", default=str(Path(__file__).resolve().parent.parent / "templates" / "kmap.config.json"))
    args = ap.parse_args()

    k = json.loads(Path(args.knowledge).read_text(encoding="utf-8"))
    cfg = json.loads(Path(args.config).read_text(encoding="utf-8")) if Path(args.config).exists() else {}
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    files = {
        "tree.mmd": render_tree(k, cfg),
        "mindmap.mmd": render_mindmap(k, cfg),
        "hierarchy.mmd": render_hierarchy(k, cfg),
    }
    flow_src, flow_stages = render_flow(k, cfg)
    files["flow.mmd"] = flow_src
    tl_src = render_timeline(k, cfg)
    if tl_src:
        files["timeline.mmd"] = tl_src
    for name, content in files.items():
        (out / name).write_text(content, encoding="utf-8")

    print(json.dumps({
        "ok": True, "out_dir": str(out), "files": list(files),
        "nodes": len(k.get("nodes", [])), "flow_stages": flow_stages,
        "note": "" if flow_stages else "flow 为空：综述类论文没有方法链，deck 里应跳过流程页",
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
