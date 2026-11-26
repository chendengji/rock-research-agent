# rock-research-agent — 部署说明

pi 的岩石力学科研 Agent 工具包。本仓库**只含功能源码**；公开可下载的依赖（node/python 包、嵌入模型）**不打包**，目标机自行下载配置。

## 前置条件（目标机）

- 已装 **Node.js ≥ 20**、**git**、**uv**（Python 环境管理）
- 已装 pi：`npm i -g @earendil-works/pi-coding-agent`
- 已配 `~/.env`：SenseNova 密钥（`SenseNova_account1/2/3_API_KEY`）、GitHub 令牌（`github_api_token`）
- 已设环境变量：`ROCK_PROJECT_ROOT`（唯一项目根）、`ROCK_PAPER_SOURCE_DIR`（论文源目录，**只读红线**）

## 安装

```bash
# 1) 克隆到 pi 包目录
git clone https://github.com/chendengji/rock-research-agent ~/.pi/agent/packages/rock-research-agent
cd ~/.pi/agent/packages/rock-research-agent

# 2) 根 node 依赖（pi 扩展）
npm install

# 3) rag-rebuild 独立 node 依赖（RAG 重建/检索 runner）
cd support/scripts/rag-rebuild && npm install && cd ../../..

# 4) 各技能 / 绘图引擎 Python 环境（uv 按 pyproject.toml 自动建 .venv）
uv sync --directory skills/experimental-analysis
uv sync --directory skills/paper-kmap
uv sync --directory skills/numerical-modeling
uv sync --directory support/plot

# 5) 复制 agent 行为定义
cp support/AGENTS.md ~/.pi/agent/AGENTS.md

# 6) 重启 pi → 自动加载扩展（rock-research / rock-journal-search）+ 8 个技能
```

## 首次运行

- 嵌入模型**自动下载**（默认走 `HF_ENDPOINT=https://hf-mirror.com` 镜像），无需手动
- 确认检索可用：先 `ingest_pdf.py` 入库，再 `rag_rebuild.mjs --clean` 建索引，然后 `paper_search` 应能命中

## 自检

```bash
# RAG 索引状态（确认库路径/表结构正常）
node --experimental-strip-types --no-warnings support/scripts/rag-rebuild/rag_rebuild.mjs --smoke
```

## 打包原则（本仓库为什么这么小）

- **不打包**：`node_modules`、各 `.venv`、嵌入模型、`~/.env` 密钥、项目数据（`ROCK_PROJECT_ROOT`）——全部目标机自行下载/配置
- **只打包**：`extensions/`（TS 工具）、`skills/`（SKILL.md+脚本+pyproject.toml）、`support/scripts/`（rag-rebuild 源码+各 py/mjs）、`support/configs/`、`support/plot/`（源码+pyproject.toml）、`package.json`、`support/AGENTS.md`
- **密钥红线**：只从 `~/.env` 读入环境变量，不落盘、不进仓库、不写记忆
- **单项目**：`ROCK_PROJECT_ROOT` 全局指定唯一项目根，文献库与业务库同根
