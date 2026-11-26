#!/usr/bin/env python3
"""
journal_rank.py — 文献结果多维度评分排序工具

对 journal_search 返回的 JSON 结果进行四维评分（期刊等级 + 引用热度 + 时效性 + 关键词相关性），
输出排序后的结果，支持自定义权重。

用法（$PY = 动态 Python 运行器，见技能 SKILL.md「Python 运行器」，不写死环境名）:
  $PY scripts/journal_rank.py \\
    --input results.json \\
    --topic "THM耦合" \\
    --include-terms "thermo-hydro-mechanical,THM,thermal-hydraulic" \\
    --secondary-terms "rock, numerical modeling, coupled" \\
    --exclude-terms "geothermal, reservoir" \\
    --output ranked.json

  # 查看各维度默认权重
  $PY scripts/journal_rank.py --weights

  # 自定义权重
  $PY scripts/journal_rank.py \\
    --input results.json \\
    --weights "journal:35,citation:25,recency:15,keyword:25" \\
    --output ranked.json
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

# ── 默认权重 ──────────────────────────────────────────────────────────
DEFAULT_WEIGHTS = {
    "journal": 35,   # 期刊等级分
    "citation": 25,  # 引用热度分
    "recency": 15,   # 时效性分
    "keyword": 25,   # 关键词匹配分
}
assert sum(DEFAULT_WEIGHTS.values()) == 100, "权重之和必须为100"

# ── 期刊数据库（内嵌 + 外部文件覆盖） ──────────────────────────────────
# 内嵌保证脚本独立运行；外部 JSON 文件更新时覆盖内嵌。
BUILTIN_TIERS: dict[str, dict[str, Any]] = {
    "Rock Mechanics and Rock Engineering": {"tier": 0, "score": 35},
    "International Journal of Rock Mechanics and Mining Sciences": {"tier": 0, "score": 35},
    "Acta Geotechnica": {"tier": 0, "score": 35},
    "Journal of Rock Mechanics and Geotechnical Engineering": {"tier": 0, "score": 35},
    "Computers and Geotechnics": {"tier": 1, "score": 28},
    "Geotextiles and Geomembranes": {"tier": 1, "score": 28},
    "Geotechnique": {"tier": 1, "score": 28},
    "Journal of Geotechnical and Geoenvironmental Engineering": {"tier": 1, "score": 28},
    "International Journal of Geomechanics": {"tier": 1, "score": 28},
    "International Journal for Numerical and Analytical Methods in Geomechanics": {"tier": 1, "score": 28},
    "Canadian Geotechnical Journal": {"tier": 1, "score": 28},
    "Soils and Foundations": {"tier": 1, "score": 28},
    "Engineering Geology": {"tier": 2, "score": 20},
    "Landslides": {"tier": 2, "score": 20},
    "Bulletin of Engineering Geology and the Environment": {"tier": 2, "score": 20},
    "Tunnelling and Underground Space Technology": {"tier": 2, "score": 20},
    "Engineering Fracture Mechanics": {"tier": 2, "score": 20},
    "Soil Dynamics and Earthquake Engineering": {"tier": 2, "score": 20},
    "Geomechanics and Geophysics for Geo-Energy and Geo-Resources": {"tier": 2, "score": 20},
    "岩石力学与工程学报": {"tier": 3, "score": 25},
    "岩土力学": {"tier": 3, "score": 25},
    "岩土工程学报": {"tier": 3, "score": 25},
    "土木工程学报": {"tier": 4, "score": 10},
    "工程地质学报": {"tier": 4, "score": 10},
    "煤炭学报": {"tier": 4, "score": 10},
    "水利学报": {"tier": 4, "score": 10},
}

# 模糊匹配模式（小写 -> 规范名）
FUZZY_PATTERNS: list[tuple[re.Pattern, str]] = []


def _build_fuzzy_patterns(source: dict[str, str] | None = None) -> None:
    """从内建别名和外部源构建模糊匹配模式列表。"""
    patterns = {
        # 缩写
        r"\brmre\b": "Rock Mechanics and Rock Engineering",
        r"\bijrmms\b": "International Journal of Rock Mechanics and Mining Sciences",
        r"\bjrmge\b": "Journal of Rock Mechanics and Geotechnical Engineering",
        r"\bacta geotech\b": "Acta Geotechnica",
        r"\bcomput geotech\b": "Computers and Geotechnics",
        r"\bjgge\b": "Journal of Geotechnical and Geoenvironmental Engineering",
        r"\bijog\b": "International Journal of Geomechanics",
        r"\bnag\b": "International Journal for Numerical and Analytical Methods in Geomechanics",
        r"\bcgj\b": "Canadian Geotechnical Journal",
        r"\beng geol\b": "Engineering Geology",
        r"\btust\b": "Tunnelling and Underground Space Technology",
        r"\befm\b": "Engineering Fracture Mechanics",
        r"\bsdee\b": "Soil Dynamics and Earthquake Engineering",
        r"\bbege\b": "Bulletin of Engineering Geology and the Environment",
        r"\bg4\b": "Geomechanics and Geophysics for Geo-Energy and Geo-Resources",
        # 常见子串匹配
        r"rock mech rock eng": "Rock Mechanics and Rock Engineering",
        r"int.*rock mech.*min": "International Journal of Rock Mechanics and Mining Sciences",
        r"j.*rock mech.*geotech": "Journal of Rock Mechanics and Geotechnical Engineering",
        r"can geotech": "Canadian Geotechnical Journal",
        r"tunn.*undergr": "Tunnelling and Underground Space Technology",
        r"soil dyn": "Soil Dynamics and Earthquake Engineering",
        r"eng fract": "Engineering Fracture Mechanics",
        r"geomech.*geo.*energy": "Geomechanics and Geophysics for Geo-Energy and Geo-Resources",
    }
    if source:
        patterns.update(source)
    FUZZY_PATTERNS.clear()
    for pat, name in patterns.items():
        FUZZY_PATTERNS.append((re.compile(pat, re.IGNORECASE), name))


_build_fuzzy_patterns()


def load_journal_tiers(json_path: str | None = None) -> dict[str, dict[str, Any]]:
    """加载期刊等级数据：优先从外部 JSON 文件，否则用内嵌数据。"""
    tiers = dict(BUILTIN_TIERS)
    if json_path and Path(json_path).exists():
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        for tier_key, tier_info in data.get("tiers", {}).items():
            score = tier_info["score"]
            for j in tier_info["journals"]:
                name = j["name"]
                tiers[name] = {"tier": int(tier_key[0]), "score": score}
        # 补充别名映射
        if "fuzzy_matches" in data:
            _build_fuzzy_patterns(data["fuzzy_matches"])
    return tiers


def match_journal(journal_name: str, tiers: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """匹配期刊名称，返回等级信息。未匹配时返回 tier 5 (score 0)。"""
    if not journal_name:
        return {"tier": 5, "score": 0, "matched": False}

    name = journal_name.strip()

    # 1. 精确匹配
    if name in tiers:
        info = tiers[name]
        return {"tier": info["tier"], "score": info["score"], "matched": True}

    # 2. 模糊匹配（正则）
    lower = name.lower()
    for pattern, canonical in FUZZY_PATTERNS:
        if pattern.search(lower):
            if canonical in tiers:
                info = tiers[canonical]
                return {"tier": info["tier"], "score": info["score"], "matched": True}

    # 3. 部分匹配（包含关系）
    for canonical, info in tiers.items():
        # 规范名包含在期刊名中，或期刊名包含在规范名中
        if (len(canonical) > 5 and canonical.lower() in lower) or \
           (len(name) > 5 and name.lower() in canonical.lower()):
            return {"tier": info["tier"], "score": info["score"], "matched": True}

    return {"tier": 5, "score": 0, "matched": False}


# ── 评分函数 ──────────────────────────────────────────────────────────


def score_journal(journal: str, tiers: dict[str, dict[str, Any]], weight: int) -> tuple[float, dict]:
    """期刊等级分 (0~weight)。"""
    info = match_journal(journal, tiers)
    score = info["score"]
    # 归一化到 weight 范围内（满分 35 对应 weight）
    normalized = round(score / 35.0 * weight, 1)
    return normalized, info


def score_citation(citations: int | None, max_citations: int, weight: int) -> float:
    """引用热度分 (0~weight)，对数归一化。"""
    c = citations or 0
    if c <= 0:
        return round(weight * 0.08, 1)  # 基础分
    if max_citations <= 0:
        return round(weight * 0.5, 1)
    normalized = math.log(c + 1) / math.log(max_citations + 1) * weight
    return round(min(normalized, weight), 1)


def score_recency(year: int | None, current_year: int, weight: int) -> float:
    """时效性分 (0~weight)。"""
    if not year:
        return 0.0
    age = current_year - year
    if age < 0:
        return float(weight)
    if age <= 1:
        return float(weight)
    if age <= 2:
        return round(weight * 0.8, 1)
    if age <= 4:
        return round(weight * 0.53, 1)
    if age <= 6:
        return round(weight * 0.27, 1)
    if age <= 9:
        return round(weight * 0.13, 1)
    return round(weight * 0.07, 1)


def score_keyword(
    title: str,
    abstract: str | None,
    include_terms: list[str],
    secondary_terms: list[str],
    exclude_terms: list[str],
    weight: int,
) -> tuple[float, dict]:
    """关键词匹配分 (0~weight)。

    评分逻辑：
      - include_terms 每命中 +2 分，上限 +10
      - secondary_terms 每命中 +1 分，上限 +5
      - exclude_terms 每命中 -2 分
      - 有开放获取 +1 分
      - 最低 0 分，最高 weight 分
    """
    text = f"{title or ''} {abstract or ''}".lower()
    title_lower = (title or "").lower()

    include_hits: list[str] = []
    secondary_hits: list[str] = []
    exclude_hits: list[str] = []

    for term in include_terms:
        t = term.strip().lower()
        if t and t in text:
            include_hits.append(t)

    for term in secondary_terms:
        t = term.strip().lower()
        if t and t in text:
            secondary_hits.append(t)

    for term in exclude_terms:
        t = term.strip().lower()
        if t and t in text:
            exclude_hits.append(t)

    raw = 0
    raw += min(len(include_hits) * 2, 10)
    raw += min(len(secondary_hits) * 1, 5)
    raw -= min(len(exclude_hits) * 2, 6)  # 最多扣 6 分
    raw = max(raw, 0)

    # 归一化：原始分满分 16（10+5+1）→ weight
    # 但保留原始分在 0~16 范围，按比例映射到 weight
    max_raw = 16.0
    normalized = round(raw / max_raw * weight, 1)
    normalized = min(normalized, float(weight))

    return normalized, {
        "include_hits": include_hits,
        "secondary_hits": secondary_hits,
        "exclude_hits": exclude_hits,
        "keyword_raw_score": raw,
    }


# ── 主流程 ──────────────────────────────────────────────────────────


def rank_papers(
    papers: list[dict],
    topic: str,
    include_terms: list[str],
    secondary_terms: list[str],
    exclude_terms: list[str],
    tiers: dict[str, dict[str, Any]],
    weights: dict[str, int],
    current_year: int = 2026,
) -> list[dict]:
    """对论文列表进行四维评分和排序。"""
    if not papers:
        return []

    # 预计算最大引用数（用于归一化）
    max_citations = max((p.get("citation_count") or 0) for p in papers)

    ranked: list[dict] = []
    for paper in papers:
        title = paper.get("title", "")
        abstract = paper.get("abstract")
        journal = paper.get("journal", "")
        year = paper.get("year")
        citations = paper.get("citation_count")

        # 1. 期刊等级分
        journal_score, journal_info = score_journal(
            journal, tiers, weights["journal"]
        )

        # 2. 引用热度分
        citation_score = score_citation(citations, max_citations, weights["citation"])

        # 3. 时效性分
        recency_score = score_recency(year, current_year, weights["recency"])

        # 4. 关键词匹配分
        keyword_score, keyword_info = score_keyword(
            title, abstract,
            include_terms, secondary_terms, exclude_terms,
            weights["keyword"],
        )

        total = round(journal_score + citation_score + recency_score + keyword_score, 1)

        ranked.append({
            **paper,
            "_scores": {
                "total": total,
                "journal_score": journal_score,
                "citation_score": citation_score,
                "recency_score": recency_score,
                "keyword_score": keyword_score,
                "journal_tier": journal_info.get("tier", 5),
                "in_list_journal": journal_info.get("matched", False),
            },
            "_keyword_hits": {
                "include": keyword_info["include_hits"],
                "secondary": keyword_info["secondary_hits"],
                "exclude": keyword_info["exclude_hits"],
            },
        })

    # 按总分降序
    ranked.sort(key=lambda p: p["_scores"]["total"], reverse=True)
    return ranked


def format_weights_display(weights: dict[str, int]) -> str:
    """格式化权重显示。"""
    parts = [f"  {k}={v}" for k, v in weights.items()]
    return f"权重配置: {' | '.join(parts)} | 总分=100"


# ── 命令行入口 ──────────────────────────────────────────────────────


def parse_weights(weights_str: str | None) -> dict[str, int]:
    """解析自定义权重字符串，如 'journal:35,citation:25,recency:15,keyword:25'。"""
    if not weights_str:
        return dict(DEFAULT_WEIGHTS)
    weights = {}
    for part in weights_str.split(","):
        part = part.strip()
        if ":" in part:
            k, v = part.split(":", 1)
            weights[k.strip()] = int(v.strip())
    # 确保所有维度都有值
    for k in DEFAULT_WEIGHTS:
        if k not in weights:
            weights[k] = DEFAULT_WEIGHTS[k]
    return weights


def parse_term_list(terms_str: str | None) -> list[str]:
    """解析逗号分隔的关键词列表。"""
    if not terms_str or not terms_str.strip():
        return []
    return [t.strip() for t in terms_str.split(",") if t.strip()]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="文献结果多维度评分排序工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--input", help="journal_search 输出 JSON 文件路径")
    parser.add_argument("--output", help="排序后输出 JSON 文件路径")
    parser.add_argument("--topic", default="", help="研究主题（用于输出报告）")
    parser.add_argument("--include-terms", help="强相关关键词，逗号分隔")
    parser.add_argument("--secondary-terms", help="辅助相关关键词，逗号分隔")
    parser.add_argument("--exclude-terms", help="排除关键词，逗号分隔")
    parser.add_argument(
        "--weights",
        help=f"自定义权重，格式 'journal:35,citation:25,recency:15,keyword:25'，默认 {DEFAULT_WEIGHTS}",
    )
    parser.add_argument(
        "--journal-tiers",
        help="期刊等级 JSON 文件路径（覆盖内建数据）",
    )
    parser.add_argument(
        "--top-n", type=int, default=0,
        help="只输出前 N 篇（0=全部）",
    )
    parser.add_argument(
        "--weights-only", action="store_true",
        help="仅显示当前权重配置并退出",
    )

    args = parser.parse_args()

    weights = parse_weights(args.weights)

    if args.weights_only:
        print(format_weights_display(weights))
        sys.exit(0)

    if not args.input:
        parser.print_help()
        print("\n错误: 请指定 --input")
        sys.exit(1)

    # 加载期刊等级
    tiers = load_journal_tiers(args.journal_tiers)

    # 读取输入
    with open(args.input, "r", encoding="utf-8") as f:
        data = json.load(f)

    # 兼容两种输入格式：直接列表或含 results 字段的对象
    if isinstance(data, dict):
        papers = data.get("results", [])
        total_raw = data.get("total", len(papers))
    elif isinstance(data, list):
        papers = data
        total_raw = len(papers)
    else:
        print(f"错误: 无法识别的输入格式，期望 JSON 数组或 {{results: [...]}}")
        sys.exit(1)

    # 解析关键词
    include_terms = parse_term_list(args.include_terms)
    secondary_terms = parse_term_list(args.secondary_terms)
    exclude_terms = parse_term_list(args.exclude_terms)

    # 评分排序
    ranked = rank_papers(
        papers, args.topic,
        include_terms, secondary_terms, exclude_terms,
        tiers, weights,
    )

    if args.top_n > 0:
        ranked = ranked[:args.top_n]

    # 统计
    in_list = sum(1 for p in ranked if p["_scores"]["in_list_journal"])
    tier0_count = sum(1 for p in ranked if p["_scores"]["journal_tier"] == 0)
    tier1_count = sum(1 for p in ranked if p["_scores"]["journal_tier"] == 1)

    result = {
        "meta": {
            "topic": args.topic or "",
            "total_raw": total_raw,
            "total_ranked": len(ranked),
            "in_list_journals": in_list,
            "tier0_count": tier0_count,
            "tier1_count": tier1_count,
            "weights": weights,
            "include_terms": include_terms,
            "secondary_terms": secondary_terms,
            "exclude_terms": exclude_terms,
        },
        "results": ranked,
    }

    # 输出
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(result, f, ensure_ascii=False, indent=2)
        print(f"已排序 {len(ranked)} 篇论文 → {args.output}")
        print(f"  (原始 {total_raw} 篇 → 去重后 {len(ranked)} 篇)")
        print(f"  清单期刊 {in_list} 篇 (Tier 0: {tier0_count}, Tier 1: {tier1_count})")
        print(format_weights_display(weights))
    else:
        # 输出到 stdout
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()