# paper-kmap

论文知识结构流水线：**读论文 → knowledge.json → 脑图/层次图/流程图 → Zotero 批注回流 → PPT**。

## 依赖

| 组件 | 状态 | 说明 |
|---|---|---|
| `zotero-cli` / MCP `zotero` | 已装 | 批注、元数据、PDF 路径、图框 |
| `mmdc`（mermaid-cli） | 已装（全局 npm） | `.mmd` → `.svg` / `.png` |
| PyMuPDF（zotero-mcp 工具环境） | 一次性补装 | `layout` / `outline` / 截图需要 |
| 本技能 Python 环境 | 动态（见下） | pymupdf / python-pptx / pillow / pywin32 |
| PowerPoint | 可选 | COM 路线插入可编辑 SVG；没有则降级 PNG |

> **Python 运行器 `$PY`（环境放技能目录，单技能隔离）**：① 技能自带 `.venv`（`"$SK/.venv/Scripts/python.exe"` Windows / `"$SK/.venv/bin/python"` Unix，**存在即优先**）→ 用它；② 本地项目 `.venv` → 用它；③ 未配置 → `uv run --directory "$SK"`（**uv 优先**，按 `pyproject.toml` 建到技能目录 `.venv/`）；④ 兜底 → `python3`/`python`。**不再读全局 `ROCK_PYTHON`**——那是绘图专用环境（sci-plot），与本技能无关。脚本一律 `$PY scripts/<脚本>.py <参数>`，**不写死 uv/conda/环境名**。

依赖安装（确保 `$PY` 指向的环境含 pymupdf / python-pptx / pillow / pywin32）：
- **本技能环境**：技能自带 `.venv/`（`$SK/.venv/Scripts/python.exe`），依赖已含；若缺失用 `uv sync --directory "$SK"` 或 `uv pip install --python "$SK/.venv/Scripts/python.exe" pymupdf python-pptx pillow pywin32` 补装，不写死具体工具。
- zotero-mcp 工具环境补 PyMuPDF（只做一次）：用该环境自己的 pip/uv 安装，路径不写死（`pip install pymupdf` 或 `uv pip install --python <该环境python> pymupdf`）

## 快速开始

```powershell
$SK = "$HOME\.pi\agent\packages\rock-research-agent\skills\paper-kmap"  # 或 $env:ROCK_AGENT_PKG\skills\paper-kmap
$LIB = "$env:ROCK_PROJECT_ROOT"  # 库路径走环境变量，不写死绝对路径

# 建档（Zotero 模式示例：软链/复制 PDF；本地模式 --json paper-raw/<citekey>.json 不复制 PDF）
$PY scripts/init_reading.py --item-key FKG6YS2W --citekey 2021-Meng-brittleness --lib $LIB
$P = "$LIB\paper-reading\2021-Meng-brittleness"
Set-Location $P

# 解析
$PY scripts/pdf_pages.py --pdf source/paper.pdf --out source/pages.jsonl

# 图/表框 + 裁剪（figs/Fn.png）
$PY scripts/figures_extract.py --attachment-key 7V7YN3WD --paper-dir .
$PY scripts/figures_crop.py --attachment-key 7V7YN3WD --paper-dir .

# 理解（由 agent 按 stages/s3-kmap.md 写 knowledge.v1.json）

# 出图
$PY scripts/kmap2mmd.py --knowledge knowledge.v1.json --out-dir maps/v1 \
  --config "$SK\templates\kmap.config.json"
$PY scripts/render_maps.py --dir maps/v1 --config "$SK\templates\mermaid.json" --png

# 批注回流
$PY scripts/ann_geom.py --item-key FKG6YS2W --pdf source/paper.pdf --out annotations.json
$PY scripts/crop_annotations.py --paper-dir .
$PY scripts/refocus.py --paper-dir .
$PY scripts/kmap2mmd.py --knowledge knowledge.v2.json --out-dir maps/v2 \
  --config "$SK\templates\kmap.config.json"
$PY scripts/render_maps.py --dir maps/v2 --config "$SK\templates\mermaid.json" --png

# 校验 + 成稿
$PY scripts/validate.py --paper-dir . --level all
$PY scripts/build_deck.py --deck deck/deck.json --out deck/deck.pptx --svg-backend com

# 笔记型 PPT（1-2 页个人笔记，M4）
$PY scripts/build_note.py --note note/note.json --out note/note-2p.pptx --pages 2
```

## 文件地图

```
SKILL.md                 路由：四种模式（M1 冷读 / M2 回流 / M3 成稿 / M4 笔记）+ 铁律 + 命令速查
core/principles.md       为什么是"知识模型 + 投影"
core/pipeline.md         阶段表、状态机、幂等、降级
core/contracts.md        三个 JSON 的字段契约
core/zotero.md           批注/几何/截图的坑（含实测结论）
core/maps.md             Mermaid 规则、预算、SVG 进 PPT 要求
core/deck.md             PPT 叙事与版式
core/quality-gates.md    G1–G9 闸门
core/note.md             笔记型 PPT（1-2 页，作者话/我的思考分色）
core/domain.md           子功能：领域字典（rock-mechanics 接入，术语/判据口径）
stages/s1…s7.md          每阶段操作卡（含提示词骨架）
templates/               配置、Mermaid 源、JSON Schema
scripts/                 13 个确定性脚本
```

## 设计约束（别改）

1. 图只从 `knowledge.json` 渲染，模型不写 Mermaid 成品。
2. 节点必须有 `page` + 逐字 `quote`。
3. `htmlLabels: false` 必须在 Mermaid 配置顶层，否则 SVG 含 `foreignObject`，PPT 里文字消失。
4. 批注只读；写回 Zotero 必须先经用户确认。
5. 预算：≤ 60 节点、≤ 4 层、每父 ≤ 6 子（**渲染层规范**，超限在 S4 聚合，不删认知层节点）。
6. PPT 分流：层次图/流程图用 COM 插可编辑 SVG；**脑图在 PPT 里用 PNG**（PowerPoint 渲染 mindmap SVG 会丢字，实测），可编辑 SVG 仍落 `maps/`。

## 常见故障

| 现象 | 处理 |
|---|---|
| `layout` 报 requires PyMuPDF | 用 `$PY` 对应环境补装 pymupdf（见上「依赖安装」） |
| `zotero-cli ... --json` 报 unrecognized | `--json` 放子命令前 |
| 截图空白/半页 | `--start-page` 用 `page_index + 1`；rect 用 `rects_norm` |
| SVG 进 PPT 空白 | 检查 `foreignObject`，重跑 `render_maps.py`；`mindmap*` 的空白是 PowerPoint 自身缺陷，已自动降级 PNG |
| PPT 图是 PNG | 没装 PowerPoint 或 COM 失败；`svgplan.json` 可重放 |
| 中文变方框 | 目标机无 `Microsoft YaHei`，导出 PDF 备份 |
