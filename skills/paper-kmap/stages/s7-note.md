# S7-note 笔记型 PPT：一篇论文浓缩成一页/两页

**目标**：把一篇已精读的论文压成 **1-2 页个人笔记 PPT**（不是讲稿）。社区共识（Keshav 三遍法 + journal-club 顺序 + one-pager 平衡）把它定为：**问题→方法→关键结果→结论→局限→我的启发**，用**颜色区分"作者的话"和"我的话"**，图用原文图，每块 1-3 行，**不抄摘要**。

与组会 PPT（`stages/s7-deck.md`，10 页讲给别人听）**并列**，共用 `knowledge.v2.json` + `annotations.json`，但这是"给自己看"的笔记。

## 1. 写 note.json（schema note/1）

输入：`knowledge.v2.json`（节点带 text/page/quote/importance/figures）+ `annotations.json`（我的批注）+ `source/figures.json`（图框+caption）。

```
你在把一篇已精读的论文压成 1-2 页个人笔记。
输入：knowledge.v2.json、annotations.json、source/figures.json。
要求：
1) takeaway 与 reuse 必须是我的话（结合我的批注与课题），不是摘要复述。
2) question/method/results/conclusion/limits 是作者的话，可直接用 quote，但要短。
3) results 优先用我框选过的图（annotations 里 type=image，ann/*.png），其次 figs/Fn.png（原文图，agent 自主裁剪）；take 写作者原话。PDF 截图（figs/*.png）完全由 agent 自主决定——只在需要原文图时按需裁剪，不是硬抽所有图。
4) mine 分 insight（我的思考，蓝）与 question（待查证，黄），各 1-3 条。
5) 每块 1-3 行，宁少勿多。整篇 6 个模块，不写背景综述。
6) 判据/公式用领域字典标准术语（可先跑 scripts/domain.py --area <相关>）；mine/reuse 引用判据时用标准名（如"峰后形状类""W_et"），不口语化。
输出 JSON：{schema:"note/1", meta, pages, takeaway, question, method, results, conclusion, limits, mine, reuse}
```

字段（详见 `core/note.md`）：

| 字段 | 规则 |
|---|---|
| `pages` | 2（默认，信息全）或 1（浓缩） |
| `takeaway` | **我的话**，≤80 字，一句话结论（最显眼） |
| `question.text/gap` | 作者的话：研究问题 + 前人缺口 |
| `method[]` | 只留"理解这篇"所需的变量/过程，1-3 条 |
| `results[]` | 论文自己的图 + `take`（作者原话：证明了什么） |
| `conclusion[]/limits[]` | 作者的话，1-3 条 |
| `mine[]` | 我的话：`insight`（蓝）/ `question`（黄，待查） |
| `reuse` | 我的话：三个月后怎么用 |

## 2. 构建

```bash
$PY scripts/build_note.py --note note/note.json --out note/note-2p.pptx --pages 2
$PY scripts/build_note.py --note note/note.json --out note/note-1p.pptx --pages 1
```

产物：`note/note-{1p|2p}.pptx`（16:9，无备注——给自己看的笔记）。**不需要** SVG/COM 路线（只放原文图 PNG），无 PowerPoint SVG 坑。

## 3. 验收（真的打开看）

| 检查 | 标准 |
|---|---|
| 页数 | 与 `--pages` 一致，无空白 |
| 语义色 | 红=作者的话 / 蓝=我的思考 / 黄=待查，一眼可分 |
| 图 | 原文图清晰、等比、未拉伸；caption 完整 |
| 文字 | 无溢出、无压图；最小字号 ≥ 11 |
| "我的话" | `takeaway`/`mine`/`reuse` 是**我自己的话**，不是摘要复述 |

程序化校验（走 validate 的 note 级检查）：

```bash
$PY scripts/validate.py --paper-dir . --level note
```

`note` 级检查：`note/note.json` 存在、`schema=note/1`、`question.text` 非空、每张 `results[].figure` 文件存在；`takeaway`/`reuse` 缺失会告警（应该是"我的话"）。

## 4. 交付话术

> 笔记型 PPT 好了：`note/note-2p.pptx`（2 页）+ `note/note-1p.pptx`（1 页浓缩）。红=作者的话，蓝=我的思考（2 条），黄=待查证（1 条），底部写了三个月后怎么用。组会 PPT 另在 `deck/deck.pptx`，互不影响。

## 坑

- 别把 `takeaway` 写成摘要：它是**我读完记得的一句话**，不是作者摘要。
- 图优先 `ann/*.png`（我框选的），没有才 `figs/*.png`（layout 裁的）。
- 一页版放不下 3 张结果图 → 减到 1-2 张，或改两页版。
