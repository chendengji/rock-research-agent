# rock-journal-search

Rock 期刊优先级文献检索扩展。三个官方开放 API（CrossRef REST / OpenAlex REST /
Semantic Scholar Graph）并发检索，按 DOI/标题去重合并，交给 `journal-search` 技能的
`journal_rank.py` 做四维评分（期刊等级 35 + 引用热度 25 + 时效性 15 + 关键词 25）排序返回。

## 工具

| 工具 | 说明 |
|------|------|
| `journal_search` | 多源并发检索 + 26 刊分级排序（核心） |
| `get_paper_by_id` | DOI / OpenAlex W-id / S2 id 查论文详情 + 引用 |
| `get_citation` | DOI → 格式化引用（CrossRef 内容协商） |
| `journal_tiers` | 26 刊分级表（Tier 0-5 + 分数） |

## 依赖

- `journal-search` 技能：默认解析到本包根的 `skills/journal-search/`
  （含 `scripts/journal_rank.py` 与 `references/journal_tiers.json`）；
  如技能单独部署，可设环境变量 `JOURNAL_SKILL_DIR` 覆盖
- Python3（仅标准库，运行 `journal_rank.py`）：优先技能目录自带环境（`skills/journal-search/.venv`），
  不存在则 `uv run --directory <技能目录> python`，再兜底系统 `python`/`python3`；不读全局 `ROCK_PYTHON`
- Semantic Scholar key（可选）：`SEMANTIC_SCHOLAR_API_KEY` 或 `S2_API_KEY`
  （环境变量或 `~/.env`），用于提升 S2 限流配额；无 key 自动走匿名限流

## 合规边界

仅使用官方开放 API；不做 Sci-Hub 全文解析、不爬取 Academia/ResearchGate。
Semantic Scholar key 只从环境读取，不落盘、不打印。
单源失败不影响整体：每源独立 try/catch，返回 per-source status。

## 注册

已由包根 `rock-research-agent/package.json` 的 `pi.extensions` 统一注册（推荐方式）：

```
cd <包根> && pi install .
```

技能更新：把新的 `journal_rank.py` / `journal_tiers.json` 覆盖到本包根 `skills/journal-search/`
对应位置即可，无需改动本扩展。
