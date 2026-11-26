---
name: paper-kmap
description: 读论文（本地文献库优先，未入库用户给 PDF 地址）→按需提炼成知识结构（knowledge.json，含 LLM 叙事与洞察）→渲染思维导图/脑图/层次图/流程图（Mermaid→SVG）；做 PPT/笔记时走 Zotero MCP 读批注（注释）回流并按批注重算权重。Use when 用户说"读这篇论文/做思维导图/画流程图/把文章方法做成图/做组会 PPT/做一页笔记"。
---

# Paper KMAP — 论文知识结构流水线

一句话：**先读成 `knowledge.json`，图是它的投影；证据是刚性的，理解是柔性的，批注是权重。**

> **分层约束模型**（本技能的核心设计）：
> - **L0 红线**（不可协商，validate 强制）：证据可回溯、批注全落地、只读 Zotero、SVG 无 foreignObject、读原文本地、reliability 必标。
> - **L1 默认建议**（LLM 可覆盖，覆盖时一句话说明理由）：内容画像标签、方向性清单、图型选择、节点预算、交互方式。
> - **L2 完全自由**（技能不干预）：节点命名与层级、重点取舍、叙事线、是否加自定义字段、辅助图取舍、总结详略与风格。
>
> **定位宣言**：技能提供**方法论地图**和**工具/材料仓库**（`core/library.md` 三库），但**不是固定模具**。LLM 自主取用工具材料，自主组织理解，只对 L0 负责。**总结论文是 LLM 的认知工作，不是填表**——技能只在事后校验证据，不在事前规定骨架。

## 0. 先判模式（判错就白干）

**任务形态**：用户给引用/标题（如 `[1] 牛腾飞. …[D]. 中南大学，2024.`）→ 先检索本地文献库是否入库（S1）→ 已入库读解析 JSON / 未入库用户给 PDF 地址 → 读原文（S2，本地，不碰 Zotero MCP）→ **S3 理解抽取（LLM 自由归纳，产出 `nodes[]` + `thesis/narrative/insights`，附内容画像标签并告知用户，不强制确认）** → S4 按 `knowledge.json` 拓扑选主图（类型仅作弱先验）。**做 PPT/笔记才走 Zotero MCP 读批注**（M2-M4）。

| 模式 | 触发信号 | 入口 | 结束标志 |
|---|---|---|---|
| **M1 冷读** | 还没读过 / 没有 `knowledge.v1.json` | `stages/s1-resolve.md` → s2 → s3 → s4 | `knowledge.v1.json`（含 thesis/narrative/insights）+ 主图 1 张 + README 速览；辅助图按需 |
| **M2 回流** | 已有 v1，Zotero 批注数或时间戳变了 | `stages/s5-annotations.md` → s6 | `knowledge.v2.json` + `diff.v2.json` + 高亮版主图 |
| **M3 笔记** | 有 v2，用户说“做笔记 / 一页 PPT / 论文笔记 / 浓缩成一页” | `stages/s7-note.md` | `note/note-{1p\|2p}.pptx`（1-2 页个人笔记） |
| **M4 成稿** | 有 v2，用户说“做 PPT / 组会 / 汇报” | `stages/s7-deck.md` | `.pptx` + 备注 + 图源清单 |

> **模板**：组会 PPT（M4）默认用 `templates/deck-template.pptx` 母版（标准 16:9 13.333×7.5、版式6 纯背景、脚本自绘页脚），**项目级模板优先** `<proj>/deck/template.pptx`；图片一律 PNG（svg 取同名 png，无降级）。**笔记 PPT（M3）不用任何模板**——`build_note.py` 保持空白 `Presentation()`，纯内容布局。

判定优先用文件状态，不靠猜：

```bash
ls <LIB>/paper-reading/<citekey>/knowledge.v1.json
ls <LIB>/paper-reading/<citekey>/knowledge.v2.json
jq '.annotations_seen' <LIB>/paper-reading/<citekey>/manifest.json
```

模式可以叠加：用户第一次就说“读完直接做笔记” → M1 → M2（若无批注则跳过并说明）→ M3（笔记）；要组会汇报再走 M4（成稿）。

## 1. 七条红线（不可协商）

1. **唯一中间表示**：所有图、PPT 都从 `knowledge.vN.json` 渲染。禁止让模型直接写 Mermaid 成品、更禁止手调坐标。
2. **证据可回溯**：每个 `reliability: "fact"` 的节点必须有 `page`（PDF 0 基页）+ `quote`（逐字原文）。改写过的句子不能当 quote。
3. **批注必须全部落地**：每条批注要么挂到节点（`nodes[]`），要么生成新节点，要么进 `unmatched` 并写清原因。不允许静默丢批注。
4. **只读 Zotero**：不加批注、不改颜色、不删条目。写回是可选动作，必须用户明确要求。
5. **SVG 必须无 `foreignObject`**：否则 PowerPoint 里文字整块消失。渲染后必须检查（`scripts/render_maps.py` 已内置）。另：**mindmap SVG 在 PowerPoint 里会丢字**（实测），PPT 里脑图用 PNG，可编辑 SVG 仍在 `maps/`。
6. **读原文本地、批注才 Zotero**：读论文/做图走本地文献库（`paper-raw/*.json` 逐页全文），不碰 Zotero MCP、不复制 PDF；仅批注回流（做 PPT/笔记）才走 Zotero 读批注。
7. **可靠性必须标**：每节点标 `reliability`（`fact` 原文直接陈述 / `inference` 由事实推理 / `prior` 基于知识）。LLM 自己归纳的一律 `prior` 或 `inference`，不能当原文证据。

> **已移出红线**：节点预算（≤60 节点 / ≤4 层 / ≤6 子）是**渲染可读性规范**，见 `core/maps.md`。它只约束渲染层，**不约束认知层**——理解论文时按论文自身逻辑自由展开，超预算在渲染阶段做视图聚合（默认折叠到 L3，或出"摘要视图 + 全量视图"两套），不要为了凑预算在理解阶段丢脉络。

## 2. 主观性的一等公民：`thesis / narrative / insights`

LLM 对论文的判断不是噪音，是价值。技能给它在 schema 里留正式位置，与 `nodes[]` 并列但明确区分：

```json
{
  "thesis": "一句话：这篇论文最值得记住的一件事",
  "narrative": "LLM 自己写的叙事线（3-5 句），不是章节复述",
  "insights": [
    {"text": "作者的判据在 X 条件下可能失效", "reliability": "inference", "basis": ["node-12","node-18"]},
    {"text": "与 [2] 的方法互补", "reliability": "prior"}
  ],
  "open_questions": ["第 6 页的系数来源未说明"],
  "content_profile": ["试验主导", "含数值验证", "提出新判据"],
  "nodes": [ "…结构节点，fact 必须带 page+quote…" ]
}
```

- `thesis` / `narrative` / `insights` / `open_questions`：**鼓励写，但必须标 reliability，`inference` 必须给 `basis`（节点 id 列表）**。
- README 的"30 秒结论"直接从 `thesis` + `narrative` 渲染；`maps/` 只投影 `nodes[]`，两条线互不污染。
- 技能不规定 narrative 的章节顺序、不规定 insights 的条数——**这是 L2**。

## 3. 工作目录

`LIB` 取环境变量 `ROCK_PROJECT_ROOT`，缺省 `~/Documents/literature-review`（相对/环境变量优先，不写死绝对路径）。

```
<LIB>/paper-reading/<citekey>/
├── manifest.json            # 状态机：阶段、产物、哈希、批注水位（本地模式记 paper-raw JSON 路径，pdf_copied=false）
├── source/pages.jsonl       # 每页文本块 + bbox（需引用定位时，从 PDF 转；不复制 PDF）
├── source/figures.json      # layout 抽出的图/表框 + caption
├── knowledge.v1.json        # 冷读结果（nodes + thesis/narrative/insights）
├── knowledge.v2.json        # 批注回流结果
├── diff.v2.json             # v1→v2 变更清单（给人看）
├── annotations.json         # 批注 + 归一化 rect + 节点对齐
├── figs/  ann/              # 图片题注裁剪 / 批注截图
├── maps/v1|v2/              # 主图 + 按需辅助图：{tree,timeline,mindmap,hierarchy,flow}.{mmd,svg,png}
├── deck/{deck.json,deck.pptx,svgplan.json}   # 组会 PPT（M4）
├── note/{note.json,note-2p.pptx,note-1p.pptx} # 笔记型 PPT（M3，1-2 页）
└── README.md                # 速览（thesis + narrative + 10 条要点 + 图索引）
```

`citekey` 用短 key（`<年份>-<一作>-<短标题>`，本地模式从文件名解析）；仅 Zotero 批注回流模式才用 `zotero-<ITEMKEY>`。

## 4. 按需加载（一次只读需要的）

| 你现在要做 | 只读这些 |
|---|---|
| 先摸底（库结构） | `core/library.md`（三库总览，L0 红线贯穿） |
| 全流程总览 | `core/pipeline.md`（阶段表·状态机·幂等） |
| s1 定位建档 | `stages/s1-resolve.md` |
| s2 解析版面 | `stages/s2-read.md` |
| s3 理解抽取 | `stages/s3-kmap.md`, `core/contracts.md`, `core/principles.md`, `core/maps.md`, `core/library.md`, `core/examples.md` |
| s4 画图 | `stages/s4-maps.md`, `core/maps.md`, `templates/` |
| s5 取批注 | `stages/s5-annotations.md`, `core/zotero.md` |
| s6 重聚焦 | `stages/s6-refocus.md`, `core/contracts.md` |
| s7 做笔记 PPT | `stages/s7-note.md`, `core/note.md`, `core/contracts.md` |
| s7 做 PPT | `stages/s7-deck.md`, `core/deck.md` |
| 交付前 | `core/quality-gates.md` |
| 任意环节要领域口径 | `core/domain.md`, `scripts/domain.py` |

> **读原文走本地文献库**：`paper-raw/<citekey>.json`（逐页全文 `pages[].text`），用 `paper_read` 或 read 读，**不调 zotero-cli、不复制 PDF**——JSON 已够做知识抽取/知识图。**只有做“论文原文图”页（note/deck 的 results/figure）才需 PDF**，按需 `init_reading --pdf <源>` 或 `--link`（不占空间）；PDF 截图完全由 agent 自主决定（按需裁剪原文图，不是硬抽所有图）。
> **Zotero 批注吸收**：批注回流（s5/s6）用 zotero-cli/MCP 读你在 Zotero 做的批注（highlight 文字高亮 / image 图片框选 / note 注释 / comment 评论）→ `annotations.json`；**M3 笔记 / M4 组会吸收批注**——图优先用你框选的 `ann/*.png`（type=image），mine/批注页用你的评论与解读。

## 5. 理解与画图：建议而非规定（L1）

> **本技能的核心资产是 `stages/s3-kmap.md` §3 的理解提示词**（A 定位骨架 + B 深读抽取 + C 方向性清单）。它不是模具而是思维工具：把"怎么读深、怎么写好判断句、哪些坑常犯"提炼进提示词，分解结构交给 LLM 跟随论文自身逻辑自主决定。改进总结质量=改这些提示词，而不是加模板。

### 5.1 内容画像（替代硬分类）
S3 不再 5 选 1。给 3-5 个**描述性标签**（如"试验主导 / 含数值验证 / 提出新判据 / 方法对比"），告知用户后**直接继续提取**，不阻塞等确认（用户可随时打断纠正）。混合型论文自然处理。

### 5.2 方向清单 = 事后查漏，不是提取骨架
**先由 LLM 按论文自身组织逻辑自由归纳出结构**，再对照 `stages/s3-kmap.md` §3C 的方向性清单查漏：方法 / 结果 / 局限 / 创新点 / 可复现性、双验证、机理总结、关键数值有没有漏？漏了就补，或用一句话说明为何不适用（原文没有的不硬凑）。**不允许把内容往模板槽位里塞。**

### 5.2b 研究现状：总结式优先，罗列式仅辅助
研究背景/现状的写法直接决定知识质量，**只做总结式，罗列式仅辅助**：
- **总结式（主要产出）**：把已有工作按**特征**归类（方法/原理/精度/效率/适用条件），形成「某类工作共同特征/规律/差异」的判断句——这才是知识，是 S4 算法关系/对比图的节点与边来源。
- **罗列式（仅辅助）**：「某某做了……」的流水账**不是知识**，只作总结式的支撑，且**只保留开创性 / 首次 / 重要 / 出名 / 行业知名**的工作；普通工作不列举（流水账意义不大）。
- **三维区分**：① 方法（怎么做）② 理论（为什么）③ 论文罗列（谁做了，仅辅助）——节点 `text` 用①②的判断句，③只进 `quote`/依据，**不单独成「某某做了……」节点**。

详细指引见 `stages/s3-kmap.md` §3C「综述/方法对比」。

### 5.3 图型由拓扑决定，类型仅作弱先验
```
先看 knowledge.json 的拓扑特征：
  分支多且平级        → tree
  时间/阶段序强       → timeline
  因果/流程链明显     → flow
  层级分类清晰        → hierarchy
再看 content_profile 作弱先验修正（如"综述 + 方法演进史"偏向 timeline）。
```
不再“综述→tree/timeline、试验→flow”直接映射。主图按拓扑选 1 张；**辅助图按需，可多图**（用户要或内容明确支持时出多张，如算法关系图 + 流程链 + 思维导图并行）。

**算法关系图（`scripts/algo_rel.py`）已自适应**：不再硬编码分组/节点 id，直接从 `knowledge.json` 的 `nodes`（kind→上色）+ `edges`（rel→线型/颜色）投影。LLM 自主归纳出关系（`refines/contrasts/part_of` 等）即驱动图型，无需迁就固定结构。

### 5.4 渲染预算（后置）
≤ 60 节点、≤ 4 层、每个父节点 ≤ 6 子节点是**渲染可读性上限**，在 S4 生效。超了做视图聚合（折叠 / 分页 / 摘要视图+全量视图），**不回退去删认知层节点**。

### 5.5 交互
默认"告知 + 继续"，不强制确认。批量读论文时强制确认是效率杀手。

## 6. 子功能：领域字典（rock-mechanics 接入）

**领域字典是 paper-kmap 的一个子功能**：给模型提供术语/判据/公式/分类的统一口径，可**单独用**，也可在**各环节调用**。

- 数据源：`scripts/domain.py`（机器可读、唯一来源）；说明见 `core/domain.md`。
- 单独用：`domain.py --list` / `--area <id>` / `--query <词>`。
- 各环节：先用 `domain.py --prompt [--area-filter …]` 把口径注入该阶段提示词，再让模型命名/解读（s2/s3/s4/s5/s6/s7 已留钩子）。
- 纪律：知识节点 `text`/`glossary` 用字典术语；判据/公式直接引用，不口语化；拿不准先 `--query`。
- 原 `skills/rock-mechanics` 已并入本子功能并物理移除（内容在 `scripts/domain.py`）。

## 7. 命令速查

脚本统一用动态 Python 运行器 `$PY` 跑（**不写死 uv/conda/环境名**；环境优先用技能自带 `.venv/`，不在技能目录时由 `uv run --directory "$SK"` 建到技能目录，单技能隔离）：

> **`$PY` 动态选择（环境放技能目录，单技能隔离）**：① 技能自带 `.venv`（`"$SK/.venv/Scripts/python.exe"` Windows / `"$SK/.venv/bin/python"` Unix，**存在即优先**）→ 用它；② 本地项目 `.venv` → 用它；③ 未配置 → `uv run --directory "$SK"`（**uv 优先**，按技能 `pyproject.toml` 把环境建到技能目录 `.venv/`）；④ 兜底 → `python3`/`python`。**不再读全局 `ROCK_PYTHON`**——那是绘图专用环境（sci-plot），与本技能无关。

```bash
SK="$HOME/.pi/agent/packages/rock-research-agent/skills/paper-kmap"  # 或 $ROCK_AGENT_PKG/skills/paper-kmap

# 本地模式（读原文/做图，不碰 Zotero）
$PY scripts/init_reading.py --json "$ROCK_PROJECT_ROOT/paper-raw/<citekey>.json" --lib "$ROCK_PROJECT_ROOT"
# Zotero 模式（批注回流，s5/s6 用）
$PY scripts/init_reading.py --item-key ABCD1234 --citekey 2023-Luo-water
$PY scripts/pdf_pages.py --pdf <源目录/paper.pdf> --out source/pages.jsonl
$PY scripts/figures_extract.py --pdf source/paper.pdf --out source/figures.json  # 抽取图表框（可选）
$PY scripts/figures_local.py --pdf source/paper.pdf --out figs  # 本地自主截图（无 Zotero）：自动找 caption 裁剪原文图
$PY scripts/figures_crop.py --paper-dir .  # 裁剪 Zotero 批注图到 ann/（批注回流用）
$PY scripts/ann_geom.py --item-key ABCD1234 --pdf source/paper.pdf --out annotations.json
$PY scripts/crop_annotations.py --paper-dir .
$PY scripts/refocus.py --paper-dir .
$PY scripts/kmap2mmd.py --knowledge knowledge.v2.json --out-dir maps/v2 --config templates/kmap.config.json
$PY scripts/render_maps.py --dir maps/v2 --config templates/mermaid.json
$PY scripts/validate.py --paper-dir . --level all
$PY scripts/build_deck.py --deck deck/deck.json --out deck/deck.pptx
$PY scripts/build_note.py --note note/note.json --out note/note-2p.pptx --pages 2

# 子功能：领域字典（rock-mechanics 接入）
$PY scripts/domain.py --list
$PY scripts/domain.py --area rockburst
$PY scripts/domain.py --query "脆性"
$PY scripts/domain.py --prompt --area-filter rockburst,dynamic-fracture
```

Zotero 侧（**`--json` 必须写在子命令前面**，写后面会报 unrecognized arguments；**仅批注回流 s5/s6 用**，读原文不调）：

```bash
zotero-cli --json search "paper title"
zotero-cli --json get metadata <ITEMKEY>
zotero-cli --json path <ITEMKEY>
zotero-cli --json annotations list --item-key <ITEMKEY>
zotero-cli --json layout <ATTACHKEY> --pages all
zotero-cli --json read <ATTACHKEY> --start-page 3 --format image --rect "x,y,w,h" --out ann/
```

## 8. 每个阶段收尾（不许跳）

1. 更新 `manifest.json`：`stage`、`artifacts`、`counts`、`hashes`、`annotations_seen`。
2. 跑该阶段的 `validate.py` 检查（**只校验 L0 红线与 schema 合法性，不校验叙事结构**），失败先修，不要带着坏数据进下一阶段。
3. 向用户一句话汇报：**产物路径 + 异常 + 下一步建议**。

例：
> v1 已生成：`knowledge.v1.json`（thesis 1 句 / narrative 4 句 / insights 3 条 / 42 个结构节点）+ `maps/v1/tree.svg` 主图。有 1 个 fact 节点引文没在页面找到，已标 `unverified`，建议瞄一眼第 6 页。要补辅助图、做 PPT，还是先去 Zotero 批注？

## 9. 交付定义（最小 + 按需）

- **M1 最小**：`knowledge.v1.json`（含 thesis/narrative/insights/open_questions）+ **主图 1 张** + `README.md`（30 秒结论、10 条要点、图索引）。辅助图按需生成（用户要才出）。
- **M2**：`knowledge.v2.json` + `diff.v2.json` + `maps/v2/` 主图（被批注节点高亮）+ 未匹配批注说明。
- **M3 笔记**：`note/note-{1p,2p}.pptx`（1-2 页个人笔记：问题→方法→结果→结论→局限→我的启发，红=作者的话/蓝=我的思考/黄=待查）。
- **M4 成稿**：`deck/deck.pptx`（≥ 8 页、每页有备注、每张图有图源）+ `deck/svgplan.json`（哪张 SVG 放在哪页，供返工）。


