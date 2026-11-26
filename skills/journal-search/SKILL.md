---
name: journal-search
description: >-
  Priority-ranked journal search for rock mechanics & geotechnical engineering.
  Loads your 26-journal subscription list, searches CrossRef/OpenAlex/Semantic
  Scholar via journal_search, then ranks by journal tier (35) + citation count
  (25) + recency (15) + keyword matching (25) via journal_rank.py. Filters out
  noise, prioritises your core journals. Use whenever you need to search for
  papers within your research scope.
argument-hint: "[search keywords or topic description]"
triggers:
  - "journal search"
  - "期刊检索"
  - "search journals"
  - "journal list"
  - "订阅期刊"
  - "文献检索"
  - "论文检索"
---

# Journal Search — 期刊优先级文献检索

## 概述

基于你的 26 种岩石力学/岩土工程订阅期刊清单，进行**迭代式策略检索**并按期刊等级 + 引用 + 时效 + 相关性综合排序。

**核心能力**：不是一次性检索，而是**检索词设计 → 试检 → 评估 → 调整 → 再检 → 扩检**的完整学术检索闭环。

---

## 前置条件

1. **检索工具可用**：Rock 下用 `journal_search` 工具（官方 API 直连：CrossRef/OpenAlex/Semantic Scholar，由 `rock-journal-search` 扩展提供）
2. **中文期刊覆盖**：CrossRef/OpenAlex 对中文期刊覆盖有限，中文检索依赖 journal_search 各源覆盖；正式中文检索建议在 CNKI/万方进行
3. **期刊清单**：`references/journal-list.md`（已加载到上下文）
4. **评分脚本**：`scripts/journal_rank.py`（`journal_search` 工具内部已自动调用它排序）
   - 四维确定性评分：期刊 35 + 引用 25 + 时效 15 + 关键词 25（合计 100）
   - 手工运行：`$PY scripts/journal_rank.py --input <json> --topic "<主题>" [--include-terms ...] [--output out.json]`（`$PY` = 动态 Python 运行器，见下「Python 运行器」；脚本仅用标准库）
   - 依赖：Python 标准库（json, math, re），无额外依赖

> **Python 运行器 `$PY`（环境放技能目录，单技能隔离）**：① 技能自带 `.venv`（`"<包根>/skills/journal-search/.venv/Scripts/python.exe"`，存在即优先）→ 用它；② 本地项目 `.venv` → 用它；③ 未配置 → `uv run --directory "<包根>/skills/journal-search"`（**uv 优先**）；④ 兜底 → `python3`/`python`。**不读全局 `ROCK_PYTHON`**。脚本一律 `$PY scripts/<脚本>.py <参数>`，**不写死 uv/conda/环境名**。（本技能仅 journal_rank.py，纯标准库，无额外依赖，任何 Python 均可；建不建技能 `.venv` 均可。）

---

## 总体架构：两阶段五步

```
第一阶段：策略构建
  Step 1 ─ 主题拆解 → 概念分解 → 检索词构建
  Step 2 ─ 初检索 → 结果评估 → 策略调整 → 再检索（循环）
  Step 3 ─ 引文追溯（雪球法）

第二阶段：评分与交付
  Step 4 ─ 去重 → 期刊匹配 → 四维评分 → 排序
  Step 5 ─ 分支展示 → 策略日志 → 导出
```

---

## 第一阶段：策略构建

### Step 1: 主题拆解与检索词构建

#### 1.1 主题拆解

首先把用户的研究主题分解为若干核心概念。例如：

```
用户输入: "THM耦合在岩石力学中的应用"
  概念A: THM耦合 / thermo-hydro-mechanical coupling
  概念B: 岩石力学 / rock mechanics
  概念C: 数值模拟 / numerical modeling (如果用户关注)
```

#### 1.2 为每个概念生成关键词

对每个概念，扩展同义词、近义词、缩写变体、上下位词：

| 概念 | 中文关键词 | 英文关键词 |
|------|-----------|-----------|
| A | THM耦合, 热-水-力耦合, 热力学-水力学-力学耦合 | "thermo-hydro-mechanical", THM, "thermal-hydraulic-mechanical", "coupled thermal" |
| B | 岩石力学, 岩石, 岩体 | "rock mechanics", rock, "rock mass" |
| C | 数值模拟, 有限元, 离散元 | "numerical modeling", "finite element", FEM, DEM |

#### 1.3 构建布尔检索式

按"概念内 OR，概念间 AND"构造多级检索式：

```
# 精准检索式（查准）
"thermo-hydro-mechanical" AND "rock mechanics"

# 扩展检索式（查全）
("thermo-hydro-mechanical" OR "thermal-hydraulic-mechanical" OR THM)
AND ("rock" OR "rock mass")
AND ("numerical" OR "finite element" OR "discrete element")

# 排除检索式（排除干扰）
("thermo-hydro-mechanical" OR THM) AND "rock" NOT "geothermal reservoir"
```

**构建原则**：
- 先做精准检索，评估结果，再逐步放宽
- 每次只变化一个维度（不要同时改多个变量）
- 记录每次检索的检索式和结果数量

#### 1.4 报告检索策略

向用户报告构建的检索策略，并询问是否调整：

```
═══ 检索策略 v1 ════════════════════════════════════════

概念拆解:
  概念 A: THM耦合 → thermo-hydro-mechanical, THM, thermal-hydraulic-mechanical
  概念 B: 岩石力学 → rock mechanics, rock mass, rock

检索式:
  [精准] "thermo-hydro-mechanical" AND "rock mechanics"
  [扩展] ("thermo-hydro-mechanical" OR THM) AND rock

搜索范围: 所有26刊 (不限期刊)
时间范围: 不限 (全部年份)
数据源: CrossRef + OpenAlex + Semantic Scholar

是否开始检索？或者需要调整？
```

用户确认后进入 Step 2。

---

### Step 2: 迭代检索循环

这是核心环节。**不是一次性检索，而是一个循环，直到结果满意为止。**

#### 2.1 检索执行

```
journal_search(query="{检索式}", limit=30, year_from={可选})
```

**重要**：`journal_search` 的 query 接受的是查询字符串，不是标准布尔语法。因此：
- 将布尔检索式简化后作为 query 传入（各 API 有自己的查询语言）
- 通用的做法是：用最核心的几个关键词，以空格分隔传入
- 精确短语用双引号包裹

**实际做法**（不依赖单个 API 的布尔语法，保证跨源兼容）：

```
# 用户构造的布尔式:
("thermo-hydro-mechanical" OR THM) AND "rock"

# 传给 journal_search 的 query:
"thermo-hydro-mechanical" THM rock

# 短语精确匹配用双引号写入 query:
"thermo-hydro-mechanical" rock
```

#### 2.2 结果评估

每次检索后，评估结果质量：

| 评估维度 | 好 | 需要调整 |
|---------|------|---------|
| **数量** | 10-40 篇 | <5 篇（太窄）或 >100 篇（太宽） |
| **相关性** | 前 5 篇与主题直接相关 | 前 5 篇都不相关 |
| **期刊覆盖** | 覆盖了你关注的核心期刊 | 全在非清单期刊 |
| **新颖度** | 包含了近 2 年的新论文 | 全是老文献 |

#### 2.3 策略调整决策树

根据评估结果，调整策略：

```
结果太少 (<5篇)？
  ├─ 放宽检索式：减少 AND 概念，增加 OR 同义词
  ├─ 扩大搜索范围：不限定期刊，增大 limit=50
  ├─ 检查是否有拼写或术语错误
  └─ 尝试其他语种关键词

结果太多 (>100篇)？
  ├─ 收紧检索式：增加 AND 限定词，加 NOT 排除
  ├─ 限定时间范围：只搜近 3-5 年
  ├─ 限定期刊：只搜 Tier 0-1
  └─ 使用精准短语（双引号）

相关性不高？
  ├─ 调整关键词：从已知相关论文中提取更准确的术语
  ├─ 限定标题/摘要搜索（如果 API 支持）
  └─ 换一组同义词或相关概念

特定期刊未覆盖？
  ├─ 单独搜索该期刊（将期刊名加入 query）
  └─ 检查该期刊是否被数据源索引
```

#### 2.4 多轮检索的实际流程

```
═══ 检索迭代过程 ════════════════════════════════════════

Round 1 ─ 精准检索
  检索式: "thermo-hydro-mechanical" AND "rock mechanics"
  结果数: 17 篇
  评估:  覆盖了核心期刊，但缺少近年的文章
  调整:  放宽时间范围，增加同义词

Round 2 ─ 扩展检索
  检索式: ("thermo-hydro-mechanical" OR THM) AND rock
  结果数: 43 篇
  评估:  结果数量合适，但部分论文与THM无关（含THM缩写但不是同一概念）
  调整:  增加排除词 "NOT thermal"

Round 3 ─ 精炼检索
  检索式: "thermo-hydro-mechanical" AND rock NOT thermal
  结果数: 28 篇
  评估:  相关性满意，覆盖了目标期刊
  状态: ✅ 达到饱和（新轮次未发现新论文）

总检索量: 3 轮 × 3 源 = 9 次 API 调用
总原始结果: 88 篇 → 去重后 52 篇
```

**多轮检索的终止条件**（满足任一即可）：
1. **饱和**：连续两轮新检索未发现新论文
2. **覆盖满意**：目标期刊已覆盖，相关性在 4 分以上
3. **用户确认**：用户认为结果足够

#### 2.5 检索日志

每轮检索记录以下信息，最后汇总为策略日志：

```
Round 1:
  query: "thermo-hydro-mechanical" AND "rock mechanics"
  limit: 30 | year_from: none
  sources: crossref, openalex, semantic_scholar
  raw_results: 32
  evaluation: 结果太少，缺少近年的文章
  adjustment: 放宽检索式，增加THM同义词

Round 2:
  query: ("thermo-hydro-mechanical" OR THM) AND rock
  limit: 30 | year_from: none
  raw_results: 89
  evaluation: 多了无关论文
  adjustment: 增加排除词 NOT thermal
```

---

### Step 3: 引文追溯（雪球法）

在 Step 2 找到一批核心论文后，可进行引文追溯：

#### 3.1 向后追溯（查看参考文献）

`get_paper_by_id` 只返回元数据与引用数，**不返回参考文献列表**。向后追溯需在出版社页面 / Zotero 条目查看参考文献，筛选与主题相关者。

#### 3.2 向前追溯（查看被引论文）

`get_paper_by_id(id="{DOI}")` 返回引用数但不返回被引列表。完整被引列表需在 Google Scholar 或 Web of Science 手动查看。

#### 3.3 回溯结果整合

将雪球法找到的论文与已有结果合并，去重，统一评分。

---

## 第二阶段：评分与交付

### Step 4: 综合评分与排序

将所有轮次检索到的论文合并、去重后，由 `journal_search` 工具内部调用 `scripts/journal_rank.py` 做**四维确定性评分**（同一输入恒同分数，无 LLM 语义层）：

| 维度 | 默认权重 | 评分方式 |
|------|---------|---------|
| 期刊等级 | 35 | 按 Tier 0~5 映射分数 |
| 引用热度 | 25 | 对数归一化：`log(c+1)/log(max+1) × 25` |
| 时效性 | 15 | 按年份距今年数阶梯给分 |
| 关键词匹配 | 25 | include_terms(+2/个) + secondary_terms(+1/个) - exclude_terms(-2/个) |

**用法**：`journal_search` 已内置该排序——直接传 query 检索即可；要加权主题相关性，另传 `include_terms`/`secondary_terms`/`exclude_terms`（只传 query 时关键词分 0/25，仅按期刊+引用+时效排序）。手工调脚本（`$PY` = 动态 Python 运行器，见上「前置条件」第 4 条）：

```bash
$PY scripts/journal_rank.py \
  --input merged_results.json \
  --topic "THM耦合" \
  --include-terms "thermo-hydro-mechanical,THM,thermal-hydraulic" \
  --secondary-terms "rock, fracture, coupled, numerical" \
  --exclude-terms "geothermal, reservoir" \
  --output ranked_results.json
```

**参数说明**：
- `--include-terms`：强相关关键词，命中每项 +2 分（上限 +10）
- `--secondary-terms`：辅助相关词，命中每项 +1 分（上限 +5）
- `--exclude-terms`：排除词，命中每项 -2 分（上限 -6）
- `--weights`：自定义权重，格式 `journal:35,citation:25,recency:15,keyword:25`
- `--journal-tiers`：期刊等级 JSON 文件路径（默认内嵌数据）
- `--top-n`：只输出前 N 篇；`--weights-only`：查看当前权重

**关键词匹配分的意义**：搜"THM耦合"时，一篇 Tier 0 但完全无关的论文得 35 分期刊分、0 分关键词；一篇 Tier 2 但标题/摘要明确含"thermo-hydro-mechanical"的论文靠关键词分拉高排名。它是**确定性术语命中**（快、可复现），不捕捉"同义不同词"——深层语义相关需人工/LLM 复核，本工具不自动做 LLM 评分。

**期刊等级数据**：`references/journal_tiers.json` 是机器可读的 26 刊分级表，更新清单只改该文件（脚本默认内嵌同一数据，也可 `--journal-tiers` 指定）。

**无 abstract 的论文**（较老）：脚本仅基于 title 做关键词匹配，影响不大。

**权重可调**：用户可随时说出"把引用权重提高，期刊权重降低"，改 `--weights` 即可。

### Step 5: 结果展示

#### 5.1 最终结果分组展示

```
╔══════════════════════════════════════════════════════════════════╗
║  "THM耦合" 文献检索结果                                        ║
║  迭代轮次: 3 轮 | 合计原始: 127 篇 | 去重后: 52 篇 | 展示前 20 ║
╚══════════════════════════════════════════════════════════════════╝

━━━ Tier 0 · 岩石力学核心 (8篇) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 1. [96分] A coupled thermo-hydro-mechanical model...
    RMRE (2025) · 被引 23 · 关键词 ●●●●○ · Round 2
    DOI: 10.1007/s00603-025-04200-0  |  [全文(DOI)] [详情]

 2. [88分] Numerical investigation of THM behavior...
    IJRMMS (2024) · 被引 15 · 关键词 ●●●○○ · Round 1
    DOI: 10.1016/...  |  [全文(DOI)] [详情]

━━━ Tier 1 · 岩土工程核心 (12篇) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 3. [79分] ...
    ...

━━━ ⚡ 引文追溯新增 (3篇) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 20. [91分] A thermo-mechanical model for...
    Int J Rock Mech Min (2023) · 被引 31
    ← 从论文 #1 的参考文献中发现

━━━ 检索策略日志 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Round 1: "thermo-hydro-mechanical" AND "rock mechanics" → 17篇 (太窄)
  Round 2: ("thermo-hydro-mechanical" OR THM) AND rock   → 43篇 (调整)
  Round 3: "thermo-hydro-mechanical" AND rock NOT thermal → 28篇 ✅
  Snowball: 从论文 #1, #5 追溯 → 新增 3 篇
━━━ 操作提示 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  • 筛选:    "只看 Tier 0-1" / "只看 2024 年以后" / "只看相关性 4+"
  • 重新排序: "/引用" / "/时间" / "/期刊"
  • 导出:     "导出前 20 篇为 CSV/BibTeX 文件"
  • 详情:     "查看第 3 篇的详细信息"
  • 全文:     "第 3 篇的全文链接"（提供 DOI/OA 链接，不自动下载）
  • 再检索:   "换个方向，我更关注热处理" / "再搜一轮，加关键词 X"
  • 调权重:   "把引用权重提高，期刊权重降低"
  • 策略日志: "保存检索策略日志"
```

#### 5.2 策略日志

每次检索结束时，产出一份**检索策略日志**，可保存为文件：

```
## 检索策略日志

### 主题
THM耦合在岩石力学中的应用

### 检索日期
<检索日期>

### 检索源
journal_search：CrossRef + OpenAlex + Semantic Scholar（无 Google Scholar / CNKI）

### 迭代记录
| 轮次 | 检索式 | 结果数 | 评估 | 调整 |
|------|--------|--------|------|------|
| 1 | "thermo-hydro-mechanical" AND "rock mechanics" | 17 | 太窄 | 放宽 |
| 2 | ("thermo-hydro-mechanical" OR THM) AND rock | 43 | 有噪声 | 加排除词 |
| 3 | "thermo-hydro-mechanical" AND rock NOT thermal | 28 | 满意 | 终止 |

### 最终结果
- 去重后总论文数: 52
- 覆盖期刊: 12 种（含 5 种 Tier 0-1）
- 引文追溯新增: 3 篇
- 中文期刊: 建议在 CNKI/万方补充（本工具不覆盖中文期刊）

### 局限性
- 中文期刊覆盖不全，建议在 CNKI/万方检索
- 最新论文可能未收录
```

---

## 完整使用示例

### 示例 1: 主题检索

```
用户: 搜索THM耦合在岩石力学中的应用

Rock: 让我拆解这个主题...
  概念A: THM耦合 → thermo-hydro-mechanical, THM
  概念B: 岩石力学 → rock mechanics, rock
  我建议的检索策略：
  [精准] "thermo-hydro-mechanical" AND "rock mechanics"
  [扩展] ("thermo-hydro-mechanical" OR THM) AND rock
  是否开始？

用户: 开始

→ Round 1: 精准检索 → 17篇，但缺少近年文章
→ Round 2: 扩展检索 → 43篇，有噪声
→ Round 3: 精炼 → 28篇，满意
→ 雪球法: 从3篇核心论文追溯 → 新增5篇
→ 去重后 33 篇，评分排序展示
```

### 示例 2: 指定期刊检索

```
用户: 搜索RMRE上关于岩石蠕变的文章

Rock: 检索策略：
  概念: 岩石蠕变 → rock creep, creep behavior, time-dependent deformation
  期刊限定: RMRE (Rock Mechanics and Rock Engineering)
  检索式: "rock creep" AND "Rock Mechanics and Rock Engineering"
  开始？

用户: 开始

→ Round 1: "rock creep" → 12篇RMRE
→ 评估: 缺少"time-dependent deformation"相关论文
→ Round 2: ("rock creep" OR "time-dependent") AND "Rock Mechanics" → 21篇
→ 展示结果
```

### 示例 3: 中文检索

```
用户: 三岩上关于岩爆预测的最新研究

Rock: 中文期刊在 CrossRef/OpenAlex 覆盖不全（journal_search 不含 Google Scholar/CNKI），我将：
  ① 英文搜索: "rockburst prediction" rock mechanics → 获取国际期刊相关论文
  ② 提示: 中文期刊（三岩）需在 CNKI/万方手动检索，我无法经官方 API 覆盖

用户: 好

→ 英文 journal_search 检索 → 25 篇国际期刊论文
→ 附 CNKI 检索建议
```

---

## 全文获取（可选）

本技能**不自动下载任何论文**。检索结果中的 DOI 链接由用户自行判断是否需要下载。

获取全文的合法途径（按优先级排序）：

1. **DOI 直接访问**：`https://doi.org/{DOI}` → 跳转到出版社官方页面
2. **开放获取版本**：检索结果的 `url` 字段可能是 OA 链接（OpenAlex/Semantic Scholar 提供）
3. **机构访问**：通过学校图书馆 VPN 或代理访问出版社页面
4. **联系作者**：通过 ResearchGate、Academia.edu 或邮件联系作者获取个人副本

**建议工作流**：查看检索结果 → 对感兴趣的论文点击 DOI → 通过学校图书馆下载 → 仍无法获取时联系作者

---

## 入库 Zotero（可选 · 检索后的进一步操作）

检索到感兴趣的论文后，可按 DOI 把条目入库到 Zotero（走 MCP `zotero_add_item` 本地直连）。**入库目标 = 个人文库（My Library）的「未分类条目」**，不是 RSS feed 库 / group 库——MCP 当前激活库若没切回 user 库，条目会误入 feed 库。入库前先确认当前库，再确保落在未分类。

**步骤**：
1. **切库**：`zotero_list_libraries` 看当前激活库；若不在 My Library，用 `zotero_switch_library(library_type='user')` 切回。绝不导入 feed 库 / group 库。
2. **DOI 导入（不传 collections）**：`zotero_add_item(source='<DOI>', if_exists='duplicate')`，支持一次多个 DOI。不传 `collections` = 落在未分类条目；若误传导致进错 collection，用 `zotero_set_item_collections(collections=[])` 挪回。
3. **验证落点**：`zotero_get_item_metadata(item_key)` 看 collection membership 为空（=未分类）。
4. **（可选）挂用户已下载的 PDF**：`zotero_attach_file(item_key='<KEY>', file_path='<PDF 绝对路径>', link_mode='linked')`——只写 path，不复制/不移动文件、不占云配额。

**前置条件**：MCP 写需 Zotero 10+ 本地 API 授权（`zotero_authorize_local_writes`，用户点一次 Always Allow 永久）。未授权先授权再入库；写能力用 `zotero_write_capabilities` 查询。

**MCP 优势**：批量（一次多 DOI）、无界面依赖、可读回验证；**局限**：写需授权，默认只入元数据（PDF 仅在 DOI 可 OA 且 `attach_mode='auto'` 时下载）。

---

## 检索后端

本技能的检索由 `rock-journal-search` 扩展提供的工具执行：
`journal_search`（多源并发检索 + 期刊分级评分排序）、`get_paper_by_id`（DOI/ID 详情与引用数）、
`get_citation`（DOI 格式化引用）、`journal_tiers`（26 刊分级表）。


## 局限性

1. **中文期刊覆盖**：CrossRef/OpenAlex 对中文期刊覆盖不全（本工具不含 Google Scholar/CNKI），中文期刊需在 CNKI 或万方检索。
2. **布尔语法限制**：检索 API 不直接支持标准布尔语法，本技能通过关键词策略近似实现，精度不如专业数据库（Web of Science、Scopus）。
3. **引用数据滞后**：CrossRef 引用计数每月更新，最新论文引用数可能偏低。
4. **时效性**：检索数据源通常有 1-3 个月延迟，最新出版的文章可能尚未收录。
5. **API 调用量**：多轮迭代 × 多源并发 = 较多的 API 调用。注意速率限制，尤其是 Semantic Scholar 免费池。
6. **评分确定性**：`journal_rank.py` 的关键词分是确定性的（同一输入同一分数），无 LLM 语义层；主题相关性靠 `include_terms` 关键词加权近似，深层"同义不同词"的语义相关需人工/LLM 复核。