# 笔记型 PPT：一篇论文浓缩成一页/两页

**定位**：这是"**论文作为个人笔记**"，不是汇报。社区共识（Keshav 三遍法 + journal-club 顺序 + one-pager 平衡）把它定为：把一篇论文压成 **问题→方法→关键结果→结论→局限→我的启发**，用**颜色区分"作者的话"和"我的话"**，图用原文图，每块 1–3 行，**不抄摘要**。

与组会 PPT（`core/deck.md`，10 页讲给别人听）**并列**，二者共用 `knowledge.v2.json` + `annotations.json`，但版式、页数、目标不同：

| | 笔记型（`build_note.py`） | 组会型（`build_deck.py`） |
|---|---|---|
| 页数 | **1 或 2 页**（`--pages`） | 10 页 |
| 目标 | 自己的笔记（三个月后写论文能快速召回） | 向组会讲清楚 |
| 顺序 | 问题→方法→结果→结论→局限→我的启发 | 封面→骨架→批注→脑图→收尾 |
| 颜色语义 | **红=作者的话 / 蓝=我的思考 / 黄=待查** | 深蓝主色 |
| 图 | 原文图 2–3 张（`figs/`、`ann/`） | 脑图/层次图 + 批注截图 |
| 每块 | 1–3 行 | 一页一信息点 |

## 1. 为什么这样排（社区经验，不是拍脑袋）

- **不照抄论文章节**：论文的 Introduction→Method→Result 是给读者读的顺序，不是给人讲的顺序。Journal club 模板（SciSpace/Acadwrite）都强调按 **研究问题→方法→关键结果→结论→局限→对我项目的意义** 重组。
- **颜色语义**：中文精读笔记圈（小绿鲸/知乎模板）通行做法是 **红=原文客观内容 / 蓝=个人思考 / 黄=待查证**。笔记型 PPT 沿用它，一眼分清"作者说了什么"和"我怎么想"。
- **用自己的话**：Keshav 第三遍"重构"要求能合上论文重建结构；笔记的价值是"三个月后写论文能凭它快速召回"，所以 `takeaway` 和 `reuse` 必须是**我的话**，不是摘要。
- **一页一信息块**：One-pager 方法论强调视觉/文字平衡、模板引导、正文 ≥11pt、less is more。

## 2. note.json 契约（schema note/1，机器校验用 `templates/note.schema.json`）

```json
{
  "schema": "note/1",
  "meta": { "citekey": "2021-Meng-brittleness", "title": "…", "author": "…", "year": "2021",
            "venue": "…", "doi": "…" },
  "pages": 2,
  "takeaway": "先统一定义，再谈指标；强度比指标测的是强度不是脆性",
  "question": { "text": "80 个脆性指标口径不一，跨论文没法比", "gap": "多数指标缺乏统一脆性定义" },
  "method": [ "按测量方法把 80 个指标分成 11 类", "逐类用物理意义 + 实验证据批判" ],
  "results": [
    { "figure": "figs/F1.png", "caption": "Fig.1 拉压两套响应", "take": "同一岩石可脆可延，围压升高转延性" }
  ],
  "conclusion": [ "三种测法有潜力成为标准", "矿物含量指标不可外推" ],
  "limits": [ "三种测法自身仍有争议", "单裂纹模式指标不可靠" ],
  "mine": [
    { "text": "我们的岩爆判据应落在峰后形状这条线", "kind": "insight" },
    { "text": "B48-B54 在砂岩-岩爆场景是否直接排除？", "kind": "question" }
  ],
  "reuse": "用 B21-B39 扫已有 SHPB 数据，对比能量比指标排序"
}
```

字段规则：

| 字段 | 规则 |
|---|---|
| `pages` | 2（默认，信息全）或 1（浓缩）。两页版：页1=问题+方法+结果图，页2=结论+局限+我的启发。 |
| `takeaway` | **我的话**，≤80 字，一句话结论。这是整页最显眼的。 |
| `question.text` / `gap` | 作者的话：研究问题 + 前人缺口。 |
| `method[]` | 只留"理解这篇"所需的变量/过程，1–3 条，不要罗列参数。 |
| `results[]` | 用论文自己的图（`figs/Fn.png` 或 `ann/*.png`），`take` 是**作者原话**（这张图证明了什么）。 |
| `conclusion[]` / `limits[]` | 作者的话，1–3 条。 |
| `mine[]` | **我的话**。`kind=insight`（蓝，我的思考）/ `kind=question`（黄，待查证）。 |
| `reuse` | **我的话**，三个月后怎么用。 |

> 红（作者）/蓝（我）/黄（待查）是语义色，不是装饰。`takeaway` 和 `mine` 必须是我自己的话，不能是摘要复述——否则这页就失去"笔记"的意义。

## 3. 构建

```bash
$PY scripts/build_note.py \
  --note note/note.json --out note/note-2p.pptx --pages 2
# 或一页浓缩版
$PY scripts/build_note.py \
  --note note/note.json --out note/note-1p.pptx --pages 1
```

产物：`note/note-{1p|2p}.pptx`（16:9，无备注——这是给自己看的笔记，不是讲稿）。

**不需要** SVG/COM 路线：笔记型只放原文图（PNG），不插 mindmap/层次图 SVG，所以没有 PowerPoint 的 SVG 坑，也不写 `svgplan.json`。

## 4. 写 note.json 的提示词骨架

```
你在把一篇已精读的论文压成 1-2 页个人笔记。
输入：knowledge.v2.json（节点带 text/page/quote/importance/figures）、annotations.json（我的批注）、source/figures.json（图框+caption）。
要求：
1) takeaway 与 reuse 必须是我的话（结合我的批注与课题），不是摘要复述。
2) question/method/results/conclusion/limits 是作者的话，可直接用 quote，但要短。
3) results 优先用我框选过的图（annotations 里 type=image），其次 figs/Fn.png；take 写作者原话。
4) mine 分 insight（我的思考）与 question（待查证），各 1-3 条。
5) 每块 1-3 行，宁少勿多。整篇 6 个模块，不写背景综述。
6) 判据/公式用领域字典标准术语（可先跑 scripts/domain.py --area <相关>）；mine/reuse 引用判据时用标准名，不口语化。
输出 JSON：{schema:"note/1", meta, pages, takeaway, question, method, results, conclusion, limits, mine, reuse}
```

## 5. 自检

```bash
$PY scripts/validate.py --paper-dir . --level note
```

- `takeaway`、`reuse`、`mine[].text` 不含论文原句（是"我的话"）；
- 每张 `results[].figure` 文件存在；
- 两页版 2 页 / 一页版 1 页，无空白、无溢出。

## 6. 与组会 PPT 的关系

- 都从同一份 `knowledge.v2.json` + `annotations.json` 来，**不重复读论文**；
- 笔记型是"给自己看"，组会型是"讲给别人听"；两者可并行产出；
- 笔记型改一句话 → 只重跑 `build_note.py`；组会型改 → 重跑 `build_deck.py`；互不影响。
