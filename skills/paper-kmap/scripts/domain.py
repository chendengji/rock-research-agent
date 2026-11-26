#!/usr/bin/env python3
"""Rock-mechanics domain dictionary — paper-kmap sub-function.

The rock-mechanics domain knowledge (8 areas) is integrated here as a
callable sub-function of paper-kmap. It is the SINGLE machine-readable
source of the domain dictionary (the legacy `rock-mechanics` skill is kept
as a quick-reference pointer).

Three ways to use it:
  1. Standalone CLI:
       python domain.py --list
       python domain.py --area rockburst
       python domain.py --query "脆性"
  2. Prompt injection (call at any paper-kmap stage to give the model the
     domain vocabulary before naming knowledge nodes / judging methods):
       python domain.py --prompt [--area rockburst]
  3. Import:
       from domain import get_area, search, prompt_block

Guidance for the agent: name knowledge nodes with these standard terms;
quote criteria/formulas directly from here instead of inventing wording.
"""
from __future__ import annotations

import argparse
import sys

AREAS = [
    {
        "id": "rockburst",
        "name": "岩爆",
        "en": "Rockburst",
        "keywords": ["岩爆", "rockburst", "strainburst", "pillar burst",
                     "fault-slip", "岩爆倾向", "冲击地压"],
        "groups": {
            "分类": ["strainburst / pillar burst / fault-slip burst"],
            "判据": ["σθ/σc（洞壁切向应力 / 单轴抗压强度）",
                     "W_et（弹性应变能指数）",
                     "Burst Liability Index（冲击倾向指标）"],
            "影响因素": ["深度", "应力比", "岩体强度", "结构面"],
            "监测": ["AE 前兆", "微震定位"],
        },
        "note": "岩爆倾向性判据常与脆性指标联用（峰后形状类 B21-B39）；脆性是趋势，不是强度。",
    },
    {
        "id": "fracture",
        "name": "断裂力学",
        "en": "Fracture Mechanics",
        "keywords": ["断裂", "fracture", "K1c", "断裂韧度", "FPZ", "Paris",
                     "亚临界", "G1c", "J-integral"],
        "groups": {
            "断裂模式": ["Mode I / II / III / Mixed-mode"],
            "参数": ["K1c（断裂韧度）", "G1c（临界能量释放率）",
                     "J-integral", "FPZ（断裂过程区）"],
            "亚临界扩展": ["Paris law", "subcritical crack growth"],
        },
        "note": "",
    },
    {
        "id": "tunnel",
        "name": "隧道工程",
        "en": "Tunnel Engineering",
        "keywords": ["隧道", "tunnel", "RMR", "Q-system", "GSI", "支护",
                     "收敛约束", "EDZ", "围岩分级", "锚杆", "喷射混凝土"],
        "groups": {
            "围岩分级": ["RMR", "Q-system", "GSI"],
            "支护": ["喷射混凝土", "锚杆", "钢拱架"],
            "收敛约束法": ["GRC（围岩特征曲线）/ SCC（支护特征曲线）/ LDP（纵向变形曲线）"],
            "开挖损伤": ["EDZ（开挖损伤区）"],
        },
        "note": "",
    },
    {
        "id": "failure-criteria",
        "name": "破坏准则",
        "en": "Failure Criteria",
        "keywords": ["破坏准则", "failure criterion", "Hoek-Brown",
                     "Mohr-Coulomb", "强度准则", "HB", "MC", "强度包络"],
        "groups": {
            "Hoek-Brown (2002)": ["σ1 = σ3 + σci·(mb·σ3/σci + s)^a"],
            "Mohr-Coulomb": ["τ = c + σn·tanφ"],
        },
        "note": "",
    },
    {
        "id": "true-triaxial",
        "name": "真三轴",
        "en": "True Triaxial",
        "keywords": ["真三轴", "true triaxial", "Mogi", "中间主应力", "σ2"],
        "groups": {
            "应力状态": ["σ1 > σ2 > σ3"],
            "σ2 效应": ["中间主应力对强度的增强/抑制作用"],
            "准则": ["Mogi 准则"],
        },
        "note": "",
    },
    {
        "id": "ae",
        "name": "声发射",
        "en": "Acoustic Emission",
        "keywords": ["声发射", "AE", "b-value", "RA-AF", "acoustic emission",
                     "ra-af", "前兆"],
        "groups": {
            "参数": ["AE count / energy / amplitude distribution"],
            "b-value": ["b-value 分析与岩爆预测"],
            "裂纹分类": ["RA-AF：tensile（拉裂）vs shear（剪切）"],
        },
        "note": "",
    },
    {
        "id": "dynamic-fracture",
        "name": "动态断裂",
        "en": "Dynamic Fracture",
        "keywords": ["动态断裂", "dynamic fracture", "SHPB", "Hopkinson",
                     "应变率", "DIF", "DIC", "动态增强"],
        "groups": {
            "试验": ["Hopkinson bar（SHPB）"],
            "应变率效应": ["DIF（动态增强因子, dynamic increase factor）"],
            "测量": ["高速摄像", "DIC（数字图像相关）"],
        },
        "note": "SHPB 动态压缩配合高速摄像/DIC 可测峰后脆性行为，是岩爆判据的重要实验来源。",
    },
    {
        "id": "water-weakening",
        "name": "水弱化",
        "en": "Water Weakening",
        "keywords": ["水弱化", "water weakening", "含水率", "饱水",
                     "水化学", "长期强度"],
        "groups": {
            "含水率": ["含水率对强度的影响"],
            "机制": ["水化学弱化机制"],
            "长期强度": ["饱水岩体的长期强度"],
        },
        "note": "",
    },
]


def get_area(aid: str):
    for a in AREAS:
        if a["id"] == aid:
            return a
    return None


def search(query: str):
    q = query.strip().lower()
    if not q:
        return []
    hits = []
    for a in AREAS:
        matched = []
        hay = [a["id"], a["name"], a["en"], *a["keywords"]]
        hay += [v for g in a["groups"].values() for v in g]
        if a.get("note"):
            hay.append(a["note"])
        for item in hay:
            if q in str(item).lower():
                matched.append(item)
        if matched:
            hits.append((a, matched[:6]))
    return hits


def _fmt_area(a, indent="  "):
    lines = [f"{a['id']} — {a['name']}（{a['en']}）"]
    for g, items in a["groups"].items():
        lines.append(f"{indent}{g}：")
        for it in items:
            lines.append(f"{indent}  - {it}")
    if a.get("note"):
        lines.append(f"{indent}注：{a['note']}")
    return "\n".join(lines)


def prompt_block(area_ids=None):
    """Compact markdown block to inject into stage prompts."""
    areas = [get_area(x) for x in area_ids] if area_ids else AREAS
    areas = [a for a in areas if a]
    lines = ["### 领域口径（rock-mechanics，来自 scripts/domain.py）",
             "节点命名/判据/公式请用以下标准术语，不要自造名词："]
    for a in areas:
        keys = " / ".join(a["keywords"][:5])
        lines.append(f"- **{a['name']}**（{a['id']}）：{keys}")
        for g, items in a["groups"].items():
            lines.append(f"  - {g}：{ '；'.join(items) }")
        if a.get("note"):
            lines.append(f"  - 注：{a['note']}")
    return "\n".join(lines)


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="rock-mechanics domain dictionary (paper-kmap sub-function)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--list", action="store_true", help="list all areas")
    g.add_argument("--area", metavar="ID", help="show one area (e.g. rockburst)")
    g.add_argument("--query", metavar="TEXT", help="search across areas")
    g.add_argument("--prompt", action="store_true", help="emit markdown block for prompt injection")
    ap.add_argument("--area-filter", metavar="ID", help="with --prompt: only these areas (comma-separated)")
    args = ap.parse_args()

    if args.list:
        print(f"{'ID':<18}{'名称':<10}{'英文'}")
        for a in AREAS:
            print(f"{a['id']:<18}{a['name']:<10}{a['en']}")
        print(f"\n共 {len(AREAS)} 个领域。--area <ID> 看详情，--query <词> 检索。")
        return 0

    if args.area:
        a = get_area(args.area)
        if not a:
            print(f"未找到领域 '{args.area}'。--list 查看全部。", file=sys.stderr)
            return 2
        print(_fmt_area(a))
        return 0

    if args.query:
        hits = search(args.query)
        if not hits:
            print(f"未命中 '{args.query}'。--list 查看全部领域。")
            return 1
        for a, matched in hits:
            print(_fmt_area(a))
            print(f"  → 命中：{'；'.join(matched)}")
            print()
        return 0

    if args.prompt:
        ids = [x.strip() for x in args.area_filter.split(",")] if args.area_filter else None
        print(prompt_block(ids))
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
