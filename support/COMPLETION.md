# Rock — 岩石力学科研助手

把 Pi（AI coding agent CLI）改造成岩石力学方向科研助手。能力层全局装一次，数据层按项目隔离。

> 运行时 agent 指令见 `~/.pi/agent/AGENTS.md`；版本演进见 `CHANGELOG.md`。

## 架构

- **能力层（全局，`.pi/agent/packages/rock-research-agent/`）**：`extensions/` 扩展 + `skills/` 技能 + `support/scripts/` 脚本 + `support/configs/` 配置。作为 pi 包加载（技能不在 `~/.pi/agent/skills/`，该目录为空）。装一次，所有项目共用。
- **数据层（每项目一套，`~/Research-projects/<项目>/`）**：切入项目即切换整套数据，互不串线。

```
.pi/agent/packages/rock-research-agent/
├── extensions/              rock-research（24 工具）+ rock-journal-search（4 工具）
├── skills/                  8 个技能（research-core、paper-analysis、academic-writing、
│                            experimental-analysis、numerical-modeling、journal-search、
│                            paper-kmap、windows-automation）
├── support/
│   ├── scripts/             入库链 / 抽取链 / RAG 重建 / 记忆蒸馏 / 维护工具
│   ├── plot/                绘图引擎（sci-plot 已并入，供 research_plot 调用）
│   ├── configs/             rock.yaml + style_profiles
│   └── CHANGELOG.md         版本演进
└── package.json             注册为 pi 包
```

项目数据目录：`paper-raw/`（PDF + 解析 JSON）、`data/`（research.db + backups）、`.pi/rag/rag.db`（RAG 索引）、`paper-plot/`（图表输出）、`logs/`。

## 能力清单

**28 个 agent 工具**：
- rock-research（24）：`paper_search` `paper_read` `claim_verify` `claim_save` `claim_compare` `claim_evolve` `claim_supersede` `conflict_analyze` `evidence_trace` `idea_save` `idea_search` `hypothesis_save` `hypothesis_search` `hypothesis_status` `research_analyze` `project_context` `research_plot` `memory_map` `memory_search` `memory_get` `memory_reindex` `memory_add` `memory_dream` `memory_dedup`
- rock-journal-search（4）：`journal_search` `get_paper_by_id` `get_citation` `journal_tiers`

> 注：pi-local-rag 包在本机**从未安装**，不存在 `rag_query`/`rag_index`/`rag_status` 工具或 `/rag` 命令。RAG 能力由 `scripts/rag-rebuild/` 的自包含源码提供（检索走 `paper_search` 子进程，重建走 `rag_rebuild.mjs`）。

**8 个技能**：research-core、paper-analysis、academic-writing、experimental-analysis、numerical-modeling、journal-search、paper-kmap、windows-automation。

**脚本链**（`scripts/`）：
| 职责 | 脚本 |
|---|---|
| 入库链 | `ingest_pdf.py` → `parse_pdf.py` → `ocr_pdf_gpu.py`（PaddleOCR GPU 兜底） |
| 抽取链 | `extract_claims_batch.py`（常驻 runner）→ `extract_claims_llm.py`（lib + 单篇 CLI） |
| RAG | `rag-rebuild/rag_rebuild.mjs`（重建）+ `rag_query.mjs`（检索 CLI，被 `paper_search` 子进程调用） |
| 记忆库 | `~/.pi/memory-data/pi_memory.db`（本地 SQLite FTS5）+ `scripts/dream-distill/distill.mjs`（LLM 蒸馏 runner，被 `memory_dream` 子进程调用）。检索 `memory_map`/`memory_search`/`memory_get`/`memory_reindex`，写入 `memory_add`（暂存 inbox）→ `memory_dream`（蒸馏沉淀）→ `memory_dedup`（维护去重）|
| 维护 | `rebuild_index.py`（状态报告）、`backup.py`（项目库备份） |

## 操作示例

```bash
# 切入项目（agent 工作目录 = 项目文件夹）
cd ~/Research-projects/rockburst
pi                                          # 启动 agent，自动用本项目 data/research.db

# 论文入库（PDF → 解析 JSON → paper-raw/）
python3 ~/.pi/agent/packages/rock-research-agent/support/scripts/ingest_pdf.py mypaper.pdf --output paper-raw/

# 批量抽取 claim（常驻、断点续跑）
nohup python3 ~/.pi/agent/packages/rock-research-agent/support/scripts/extract_claims_batch.py ~/Research-projects/rockburst \
  --project-id 4 >> logs/claims_batch.log 2>&1 &

# RAG 索引重建（独立 runner，绕开 pi 内 ONNX 挂起）
node --experimental-strip-types --no-warnings \
  ~/.pi/agent/packages/rock-research-agent/support/scripts/rag-rebuild/rag_rebuild.mjs --clean

# 索引状态报告
python3 ~/.pi/agent/packages/rock-research-agent/support/scripts/rebuild_index.py

# 切到另一方向，数据自动隔离
cd ~/Research-projects/fracture && pi
```

检索/验证/分析在 agent 内用工具：`paper_search` 检索 → `paper_read` 读详情 → `claim_verify` 验证 → `claim_compare`/`conflict_analyze` 分析 → `evidence_trace` 溯源 → `claim_supersede` 演化。

记忆不手写 md：`memory_add` 把 agent 主动记忆追加到当天 `inbox/<日期>.md`（暂存，不进索引）→ 当天收尾或跨天时 `memory_dream` 蒸馏会话记录并分类沉淀成 `dream/` 源文件 → `scanAndIndex` 增量重建 `pi_memory.db` → inbox 归档。一个日期只 dream 一次（日期级幂等，重跑需 `force=true`）；近重复条目用 `memory_dedup` 清理（移入 `.retired/`，可恢复）。检索用 `memory_search`/`memory_map`，新会话注入量最小化。

## 风险与合规

- 改动均在用户自有 `.pi/agent/packages/rock-research-agent/support/` 与 `~/.pi/` 范围内，可逆。
- 凭证（`SenseNova_account1/2/3_API_KEY` / `SEMANTIC_SCHOLAR_API_KEY` / `github_api_token` / `SILICONFLOW_API_KEY`）只从 `~/.env` 读入环境变量，不落盘、不打印、不外发、不写入记忆。后台任务（claim 抽取/验证/蒸馏）用 `SenseNova_account1_API_KEY`（优先）/`account3`，pi 本体用 `account2`，避单账户限流。
- 期刊检索仅用官方开放 API（CrossRef / OpenAlex / Semantic Scholar），不含 Sci-Hub / 站点爬取。
- OCR 唯一路径为 PaddleOCR GPU（禁 CPU/在线 OCR 替代）；运行器动态选择、不写死环境名（`PADDLE_GPU_PYTHON` 显式指定或 uv/conda 动态解析，见 AGENTS.md「OCR 环境」）。
- 绘图用绘图引擎自带环境（`support/plot/.venv`，uv 建，环境跟归属目录走；或 `uv run --directory <引擎目录> python`），需 matplotlib/scienceplots，图表输出到 `<项目>/paper-plot/`，无外发。
