# RAG 索引重建（独立 runner）

索引重建的标准工具：绕开 pi TUI，直接调本目录的自包含源码，前台可观测。
（pi 会话内的 `/rag rebuild` 不存在——本机从未安装 pi-local-rag 包；见 AGENTS.md「禁止事项」②）

```bash
# 全量重建（清孤儿 + 重新切块嵌入；日常重建必带 --clean）
node --experimental-strip-types --no-warnings \
  ~/.pi/agent/packages/rock-research-agent/support/scripts/rag-rebuild/rag_rebuild.mjs --clean

# 指定项目根（默认 $ROCKCLAW_PROJECT_ROOT || cwd）——换项目务必显式指定，避免 --clean 误删别库
... rag_rebuild.mjs --clean --project ~/Research-projects/fracture

# 冒烟（前 2 个文件，不 --clean）
... rag_rebuild.mjs --smoke

# 检索自检（无索引返回 {no_index:true}；有索引零命中返回 []）
node --experimental-strip-types --no-warnings \
  ~/.pi/agent/packages/rock-research-agent/support/scripts/rag-rebuild/rag_query.mjs "岩爆" "$(pwd)"
```

说明：
- 项目根由 `--project` / `$ROCKCLAW_PROJECT_ROOT` / cwd 决定（脚本开头打印 `[project]` 与 `[rag.db]` 路径，`--clean` 前可见，避免抹错库）
- `--clean`：rebuild 前清空 chunks/fts/vec/files，彻底清旧构建残留的孤儿 chunk（如 `data/` 下的状态文件）；日常重建必带
- 索引 `cfg.trackedPaths` 下所有文本文件（排除 `.pdf`/`.py`）；`paper-raw/*.json` 是论文解析文本，PDF 原文与 JSON 内容重复故排除
- `chunking.ts` 含 JSON 文本提取 + PUA/全角清洗（自包含实现，无对应 npm 包）；改动直接生效，无需随包更新
- `node_modules` 软链到 `~/.pi/agent/npm/node_modules`
