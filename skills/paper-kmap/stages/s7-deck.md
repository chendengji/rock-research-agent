# S7 成稿：deck.json → PPTX

**目标**：一份能直接讲的 PPT，且每页内容都能回溯到论文或批注。

## 1. 先定场景（一句话，别猜）

| 场景 | 页数 | 叙事框架（社区共识） | 重点 |
|---|---|---|---|
| 组会文献分享 | 8–12 | 跳过背景，花在"做了什么+卡在哪" | 方法 + 关键结果 + 我的判断 |
| 综述/开题引用 | 5–7 | 一个 message，每页服务它 | 只讲与课题相关的 2–3 个点 |
| 自己复习 | 6–8 | 脑图 + 批注原话，少解读 | 能召回 |
| 给导师汇报进展 | 6–10 | "这篇能怎么用到我的实验" | 可复用点 |

场景决定 `deck.json` 的页型顺序；不确定就问。完整框架表（含答辩/会议）见 `core/deck.md` §0。

**出处进备注**：图源/批注 key 由 `build_deck.py` 自动追加到备注末尾（`[来源] …`），正文只留结论——不用手写。

## 2. 写 deck.json

- 先列 **每页一句话**（headline），再填内容。headline 是结论，不是标签：
  - ✅ "B1 测的是强度，不是脆性"
  - ❌ "脆性指标分析"
- 批注页：`annotation` 填批注 key，`quote` 逐字，`comment` 填用户原话（没有就空），`reading` 写 agent 的解读（≤ 3 行，标明是解读）。
- 图页：优先用 `ann/*.png`（用户框选的图），其次 `figs/*.png`（layout 裁的图）；不要整页截图。
- claim 表述与论文口径对齐：涉及判据/公式用领域字典术语（子功能：`$PY scripts/domain.py --prompt --area-filter <相关>`）。
- `notes` 写口播稿。

页型分配建议（10 页版）：

```
cover → claim → outline(hierarchy) → figure(flow) → figure(关键结果)
→ annotation ×2–3 → map(mindmap 局部) → limits → next
```

## 3. 构建

```bash
$PY scripts/build_deck.py \
  --deck deck/deck.json --out deck/deck.pptx --mark-rect
```

- **图片一律用 PNG**（svg 自动取同名 png，不插 SVG、无降级、不写 svgplan）——`build_deck.py` 已默认，无需 `--svg-backend`。
- **模板**：默认 `$SK/templates/deck-template.pptx`（标准 16:9，13.333×7.5）；**项目级模板优先** `<proj>/deck/template.pptx`。换模板用 `--template <path>`；不要模板传 `--template ""`（纯空白）。
- **按版式名匹配**（不写死 index）：`cover`→「封面页」、`section`→「节标题」、`final`→「末尾页」、其余正文页→「正文页-标题及内容」；**标题 fill 版式预制的标题占位符**（不自绘，长标题自动缩小字号），内容自绘。
- **末尾页 `final`**：上方文本框由 LLM 填 `summary`（汇报名称/关键词/关键结论），避免只显示"谢谢"——`{"type":"final","summary":{"title":...,"keywords":[...],"conclusion":...}}`。
- `--mark-rect`：在批注截图上画半透明红框。

产物：`deck/deck.pptx`。

## 4. 验收（必须真的打开看）

| 检查 | 标准 |
|---|---|
| 页数 | 与 deck.json 一致，无空白页 |
| 文字 | 无溢出、无压图；最小字号 ≥ 12 |
| 图 | SVG 不为空、清晰、宽高比未拉伸 |
| 批注页 | 截图能看清被标的那句话；有页码 |
| 备注 | 每页有口播稿，开头结尾是完整句子 |
| 一致性 | 术语与 `glossary` 一致（B1 不要一会儿叫 B1 一会儿叫强度比） |

程序化检查：

```bash
$PY scripts/validate.py --paper-dir . --level deck
```

## 5. 交付话术

> PPT 好了：`deck/deck.pptx`，10 页。3 页是你的批注（红标 2 条 + 1 张框选图），1 页脑图只保留了你标过的分支。第 6 页那句"作者用 σc 相关性反证"是我的解读，不是原文，讲的时候可以弱化。需要我把 v2 摘要写回 Zotero 当子笔记吗？

## 6. 可选：写回 Zotero

只有用户明确要求才做：

```bash
zotero-cli notes add --item-key <ITEMKEY> --title "KMAP v2 摘要" --file exports/summary.md
```

写前把全文给用户确认；写完不要自动改批注或标签。

## 坑

- SVG 在 PPT 里变空白 → 源文件有 `foreignObject`，回 S4 重渲染；`mindmap*` 的空白是 PowerPoint 自身缺陷，默认已降级 PNG（可编辑 SVG 仍在 `maps/`）；
- 图片拉伸 → `build_deck.py` 保持等比，出现留白是正常的，不要手动拉满；
- 中文字体缺失 → 目标机器没装 `Microsoft YaHei`，导出 PDF 备份；
- 批注截图太小 → 外扩范围加大或改用整段截图（`--context-blocks 2`）。
