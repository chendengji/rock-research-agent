# Changelog

Rock（Pi agent 改造的岩石力学科研助手）版本演进记录。能力层在 `.pi/agent/packages/rock-research-agent/support/`，数据层按项目在 `~/Research-projects/<项目>/`。

格式：日期 + 主要变更，新→旧。变更类型：✨新增 / 🛠改进 / 🐛修复 / 🧹清理。

> 约定：代码与文档内只描述当前功能，不内联版本演进记录；所有变更历史追加到本文件顶部。

---

## 2026-08-31 — 项目结构统一与清理

- 🧹 **统一版本史到 `CHANGELOG.md`**：全树代码/文档去除内联版本变更记录（`v3.0`/`v7`/`v8`/日期戳/`H4` 难项号/`§` 设计文档引用/"曾/原/替代/大修/勘误/归档"等），改为只描述当前功能。
- 🧹 **删除被取代的旧代码归档** `scripts/_archive_20260827/`（6 个：旧 `extract_claims.py`/`ocr_pdf.py` CPU 版/`*.bak`/旧 `.sh`）+ `scripts/__pycache__/` 构建产物。
- 🛠 **`COMPLETION.md` 瘦身**（325→~70 行）：去除所有"大修/审查"叙事节（已入 CHANGELOG），重写为当前态项目总览（架构 + 能力清单 + 操作示例 + 风险合规）。
- 🛠 **rag-rebuild `.ts` 去历史 + 死代码**：`rag_rebuild.mjs` 去硬编码/`/tmp/ragsrc` 残留注释；`chunking.ts` 去上游归属行；`db.ts` 删 `saveIndex` no-op shim、`store.ts` 删 `indexFile` `@deprecated` 死导出；`embed.ts`/`indexing.ts` 去演进措辞。
- 🛠 **`extract_claims_llm.py`** 去 `v7 卡死诱因` 引用；**`skills/journal-search/SKILL.md`** 示例日期改占位符；**`rock-research` 3 处 `H4` 难项号** 去除。

## 2026-08-31 — 工具链内部可用性审计

从"只看 AGENTS.md + 工具 description/schema/return 的 LLM"视角审查全链，消除靠建造者潜规则才能跑通的摩擦。

- 🐛 **`ragEnabled` 改为 false（默认 true 致命）**：pi-local-rag 的 `before_agent_start` 钩子在索引非空时每轮自动 in-process ONNX 嵌入 → 静默挂起 pi。项目 `.pi/rag/config.json` 设 false；AGENTS.md 禁令②(c) + 禁 `/rag on`。检索走 `paper_search`（子进程），重建走 `rag_rebuild.mjs --clean`。
- 🛠 **rock-research 工具描述自文档化**：`paper_read` 默认返回结构化摘要（`full=true` 才给完整 JSON）；`research_plot` 复用 `tools/research_plot.ts` 的完整 description/schema；`research_analyze` mode 大小写兼容；save 类工具 `project_id` 描述指向 `project_context` 查询。
- 🛠 **journal-search 工具**：`journal_search` 描述说明 query 非排序关键词；`get_citation` 更正返回形状；`journal_tiers` 成功/错误统一 JSON + 数据缺失恢复提示。
- 🐛 **脚本 friction 修复**：`rag_rebuild.mjs` 去硬编码项目根（`--project`，避免 `--clean` 误删别库）；`ingest_pdf.py` 默认输出目录改项目根/papers；`parse_pdf.py` OCR lang 默认 `ch`、重建 pip 路径同源；`extract_claims_batch.py` 前台 stdout 提示；`rebuild_index.py` 缺索引提示改指 runner + busy_timeout；`rag_query.mjs` 加 `--help` + 无索引哨兵。
- 🛠 **AGENTS.md 治歧义**：检索入口改指 `paper_search`；`/rag index`·`/rag search` 标禁用（in-process ONNX 挂起）；`/rag status` 可用；工作流与数据优先级链统一。

## 2026-08-30 — RAG 索引质量大修

诊断并清除索引里的 6 类噪声：`.py` 脚本 / data/ 孤儿 chunk / JSON 结构字段 / PUA 字体乱码 / 全角乱码 / 缺向量。

- ✨ **`extractText` 加 `.json` papers 分支**：解析后只取 `title`+`abstract`+`pages[].text`（丢结构字段、丢 references），不再把原始 JSON 当纯文本切。
- ✨ **`stripPua`**：去 PyMuPDF 字体映射的私用区乱码（U+E000–F8FF 等）。
- ✨ **碎片检测合并**：PUA strip 后行数爆炸（赵斌 272 chunks），对非空行 avg<30 字符的碎片文本把孤立 `\n`→空格（保留段落 `\n\n`）。
- ✨ **`isFullwidthCorrupted` 双层过滤**：页级 + `chunkText` chunk 级，丢 >30% 全角拉丁的损坏页/chunk（PyMuPDF 字体映射损坏，parse_pdf.check_text_quality 漏检）。
- ✨ **runner 过滤 `.py`** + **`--clean`**（rebuild 前全表清空，彻底清旧构建残留孤儿；`delChunks` 只删列表内文件，孤儿普通 rebuild 永清不掉）。
- 🛠 **runner 改 `./` 自包含导入**（原 `/tmp/ragsrc` 重启即丢）。
- 🧹 结果：258 论文 → 4378 chunks 全有向量，6 类噪声全清零，"岩爆"检索 Top-3 全真论文。

## 2026-08-28 — RAG 重建工具 + 补丁自愈 + 文档审查

- ✨ **RAG 重建独立 runner**（`scripts/rag-rebuild/`）：绕开 pi TUI（pi 内嵌 ONNX 静默挂起），独立 node 跑，复用 pi-local-rag 源码拷贝（type-only import 已修）。
- ✨ **`apply_patches.py` 补丁自愈机制**：注册表 + 幂等 + MISMATCH 保护；`rock-synapse-bridge.js` spawn 前自动调用；`--check` 体检。synapse-os hf-mirror 补丁纳入注册表。（已于 2026-10-24 下线：本机未安装 synapse-os，`rock-synapse-bridge.cjs` 与 `apply_patches.py` 移入 `scripts/.trash-synapse-20261024/`）
- 🧹 **文档统一审查**：`papers.db` 是幽灵文件（pi-local-rag 只有 `.pi/rag/rag.db`，无独立元数据库）；conda 绘图环境实名为 `geo`（旧文档写 geo3.13）；删 `paddle`（CPU）与 `rag`（早期实验残留）conda env；OCR 唯一环境 `paddle-gpu`。

## 2026-08-27 — claim 批抽取大修 + 数据清洗

- 🛠 **v8 batch runner**（`extract_claims_batch.py`，替代临时版）：四个叠加卡死根因——WSL2 NAT 闪断（monkeypatch getaddrinfo 强制 IPv4）、`ecll.ingest_paper` 整篇一个未提交事务持写锁（改每 chunk commit）、失败论文无限重试排 todo[0]（加 session_attempted + failed 计数跳过 + 退避）、LLM 响应含控制字符 json.loads 抛异常（`strict=False` 兜底）。
- 🐛 **CJK 分类 bug**：`parse_pdf.check_text_quality` 旧规则 density>0.95→0.3 把中文正文全判"扫描件"（汉字都是 alnum），误伤 118 篇。新逻辑按控制字符乱码率判定并触发 OCR 兜底。
- 🧹 **数据修复**：重试设计曾把 claims 膨胀到 ~1.36 万，按 (text, file_path) 保最早去重删 4478 条，净剩 9137。10 组重复 PDF 全合并（papers/ 256 pdf+256 json 一一对应）。research.db 测试项目（pid1-3）删除，旧日志归档。
- 🛠 **OCR 单 GPU 路径**：`parse_pdf.py` 硬编码 paddle-gpu 解释器跑 `ocr_pdf_gpu.py`，CPU 版归档。`ingest_pdf.py` 默认输出改 `papers/`。

## 2026-08-24 — Rock v3.0：能力全局化，数据项目化

- 🛠 **架构 v3.0**：能力层全局（`.pi/agent/packages/rock-research-agent/support/`，软链到 `~/.pi/agent/skills/`），数据层每项目一套（`~/Research-projects/<项目>/`）。三库（papers/memory/research.db）按项目落 `data/`，切入项目即切换整套数据。
- ✨ **rock-research 扩展 19 个 agent 工具**：paper_search/paper_read、claim_verify/save/compare/evolve/supersede、evidence_trace、idea_save/search、hypothesis_save/search/status、memory_save/retrieve、research_analyze、conflict_analyze、project_context、research_plot。services 全接线（Evidence→claim_verify、Evolution→claim_evolve/supersede、Reasoning→research_analyze、Conflict→conflict_analyze）。

## 2026-08-23 — 主干全通

- ✨ 端到端验证：PDF 入库（PyMuPDF，扫描件 PaddleOCR GPU 兜底）→ RAG 索引+检索（pi-local-rag，hybrid BM25+向量，HF 镜像）→ LLM 抽 claim（Agnes2 + agnes-2.5-flash）→ claim 验证/比较/溯源 → sci-plot 绘图。
- ✨ 项目化数据隔离 + pi 真实运行时工具调用验证。
- 🐛 关键坑：paddle GPU WSL2 段错误（cu130 wheel 解决）；向量模型 `Xenova/all-MiniLM-L6-v2`（偏英文，文献多英文故未换 bge-m3）。

---

后续维护：新增变更追加到本文件顶部；代码与文档内只描述当前功能，不内联版本演进记录。
