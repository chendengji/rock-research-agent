# 数据契约（三个 JSON）

机器校验用 `templates/*.schema.json`，人读看这里。字段名一律 snake_case，id 稳定不复用。

## 1. knowledge.json

```json
{
  "schema": "pkm/1",
  "meta": {
    "citekey": "2021-Meng-brittleness",
    "item_key": "FKG6YS2W",
    "title": "Rock brittleness indices and their applications…",
    "year": 2021, "venue": "Journal of Rock Mechanics and Geotechnical Engineering",
    "doi": "10.1016/j.jrmge.2021.02.004",
    "class": "review",   # 可选：S3 内容画像时顺手记录的弱标签（不用于强制分节，脚本不强校验）
    "pages": 21
  },
  "outline": [
    { "id": "S1", "title": "Introduction", "pages": [1, 3], "role": "gap" },
    { "id": "S3", "title": "Brittleness indices", "pages": [4, 14], "role": "body" }
  ],
  "nodes": [
    {
      "id": "N07", "kind": "claim", "section": "S3",
      "text": "B1（σc/σt）不能单独表征脆性",
      "detail": "随 σc 单调增，且不同 σc/σt 组合可得同一 B1，变化区间窄。",
      "page": 2, "quote": "B1 is not a satisfactory brittleness index.",
      "bbox": [72.0, 410.0, 520.0, 436.0],
      "importance": 0.82, "parent": "N05",
      "tags": ["brittleness-index", "critique"],
      "figures": ["F2"]
    }
  ],
  "edges": [
    { "from": "N05", "to": "N07", "rel": "supports" }
  ],
  "figures": [
    { "id": "F2", "page": 2, "label": "Fig. 2", "caption": "Variations of (a) Brazilian tensile strength…", "crop": "figs/F2.png", "role": "result" }
  ],
  "flow": {
    "stages": [
      { "id": "P1", "step": "取样", "io": "砂岩 φ50×100 mm", "detail": "…" },
      { "id": "P2", "step": "饱水", "io": "0/25/50/100% 含水率" }
    ]
  },
  # flow.stages 字段：step=步骤名（渲染主行，推荐）；label=旧别名（兼容，step 缺失时用）；io=输入/输出要点（渲染第二行）；detail=补充（不渲染，供 PPT 备注）；hot=true 高亮关键步骤
  # flow.graph 字段（分支/条件/并行/汇合，有 graph.nodes 则优先于 stages）：
  #   nodes=[{id, label, io?, shape?=rect|diamond(条件判断菱形), hot?}]；edges=[{from, to, label?}]（label 为边文字，如 通过/不通过）
  #   例：验证(菱形)→通过→继续 / 不通过→调整→回环。无 graph 时 flow 退化为线性链（stages→P1-->P2）。
  "template": {   # 可选：S3 选用的方向参考（弱先验记录，不再决定分节——结构跟论文自身逻辑走）
    "type": "review",
    "sections": ["framework", "timeline"]   # 仅作记录，LLM 自主增删合并
  },
  "timeline": {   # 综述/研究现状：时间脉络（有则渲染 timeline.mmd）
    "title": "射线追踪方法发展",
    "events": [
      { "year": "2000", "label": "有限差分法", "text": "基本原理：网格波动方程" },
      { "year": "2005", "label": "走时插值法", "text": "精度提升" }
    ]
  },
  "glossary": [
    { "term": "B1", "zh": "强度比脆性指标", "def": "σc/σt" }
  ],
  "gaps": ["未讨论含水率与加载速率耦合"],
  "focus": { "mode": "annotation", "version": "v2", "source": "annotations.json" }
}
```

### 字段规则

| 字段 | 规则 |
|---|---|
| `id` | `N01…` 递增，**永不复用**；合并节点时保留被合并者的 id 到 `merged_from` |
| `kind` | `question` / `gap` / `method` / `evidence` / `claim` / `mechanism` / `limitation` / `term` / `user_note` |
| `reliability` | `fact`（原文直接陈述：数值/结论/参数）/ `inference`（由事实推理：机制/归因）/ `prior`（基于知识：LLM 归纳、背景知识、文献常识）；与 kind 是不同维度，独立存 |
| `text` | ≤ 40 字，判断句，不是名词短语 |
| `detail` | ≤ 120 字，可省略 |
| `importance` | 0–1；v1 由模型给，v2 由批注重算 |
| `page` | PDF **0 基**页；引用时展示为 `page+1` |
| `quote` | 逐字原文；跨段用 ` … ` 连接；≤ 400 字符 |
| `bbox` | PDF point，左上原点（PyMuPDF 坐标）；可空 |
| `edges.rel` | `supports` / `contradicts` / `refines` / `requires` / `part_of` / `contrasts` |

## 2. annotations.json

```json
{
  "schema": "ann/1",
  "item_key": "FKG6YS2W",
  "attachment_key": "7V7YN3WD",
  "generated": "2026-10-30T12:00:00+08:00",
  "color_semantics": { "Red": { "role": "critical", "weight": 1.0 } },
  "items": [
    {
      "key": "ADPA25JG", "type": "highlight", "page_index": 2, "page_label": "223",
      "text": "(1) strength parameters, (2) shape of stressestrain curves…",
      "comment": "", "color": "#ff6666", "color_category": "Red",
      "rects": [[72.0, 300.0, 523.0, 380.0]],
      "rects_norm": [[0.095, 0.618, 0.595, 0.101]],
      "crop": "ann/ADPA25JG.png",
      "weight": 1.0, "role": "critical",
      "nodes": ["N12"], "unmatched": false
    },
    {
      "key": "LV6S5JE2", "type": "image", "page_index": 1, "page_label": "222",
      "text": "", "comment": "", "color": "#f19837", "color_category": "Orange",
      "rects": [[100.0, 120.0, 400.0, 380.0]],
      "rects_norm": [[0.131, 0.520, 0.393, 0.328]],
      "crop": "ann/LV6S5JE2.png",
      "weight": 0.9, "role": "figure",
      "nodes": ["N03", "F1"], "unmatched": false
    }
  ],
  "stats": { "total": 19, "highlight": 16, "image": 3, "with_comment": 2, "unmatched": 1 }
}
```

- `type`：`highlight` / `image` / `note` / `ink` / `underline`。
- `rects` 为 PDF point、**左下原点**（Zotero 原生坐标）；`rects_norm` 为左上原点归一化 `[x,y,w,h]`，直接喂 `zotero-cli read --rect`。
- `unmatched: true` 时必须同时有 `unmatched_reason`。

## 3. deck.json

```json
{
  "schema": "deck/1",
  "meta": { "title": "脆性指标怎么选：一篇综述的读法", "subtitle": "组会 · 2026-10-31", "audience": "课题组" },
  "slides": [
    { "id": "s1", "type": "cover", "headline": "脆性指标怎么选", "bullets": ["19 条批注 / 3 个可复用结论"], "notes": "开场 30 秒：为什么读这篇。" },
    { "id": "s5", "type": "annotation", "headline": "B1 不能单独用", "annotation": "ADPA25JG",
      "quote": "B1 is not a satisfactory brittleness index.",
      "comment": "", "reading": "作者用 σc 相关性反证 B1 测的是强度不是脆性。",
      "minimap": "maps/v2/hierarchy.svg", "notes": "停 5 秒，让听众看红框。" },
    { "id": "s6", "type": "figure", "headline": "三类可用方法", "figure": { "path": "figs/F11.png", "caption": "Fig. 11 …" }, "bullets": ["弹性变形段", "峰后曲线形态", "断裂力学"], "notes": "" },
    { "id": "s7", "type": "map", "headline": "我的理解路径", "image": "maps/v2/mindmap.svg", "notes": "" }
  ]
}
```

`type` 枚举：`cover` / `claim` / `outline` / `figure` / `annotation` / `map` / `table` / `limits` / `next` / `end`。
`notes` 一律写口播稿，不写"此处讲解"。

## 4. note.json（笔记型 PPT，1-2 页）

```json
{
  "schema": "note/1",
  "meta": { "citekey": "2021-Meng-brittleness", "title": "…", "author": "…",
            "year": "2021", "venue": "…", "doi": "…" },
  "pages": 2,
  "takeaway": "先统一定义，再谈指标",
  "question": { "text": "80 个指标口径不一", "gap": "缺乏统一脆性定义" },
  "method": ["按测量方法分成 11 类", "逐类用物理意义 + 证据批判"],
  "results": [ { "figure": "figs/F1.png", "caption": "Fig.1 …", "take": "作者原话" } ],
  "conclusion": ["三种测法有潜力成为标准"],
  "limits": ["三种测法自身仍有争议"],
  "mine": [ { "text": "我们的判据落在峰后形状", "kind": "insight" },
            { "text": "B48-B54 是否应排除？", "kind": "question" } ],
  "reuse": "用 B21-B39 扫已有 SHPB 数据"
}
```

- 语义色：**红=作者的话**（question/method/results/conclusion/limits）、**蓝=我的思考**（`mine[].kind=insight`）、**黄=待查证**（`mine[].kind=question`）。
- `takeaway`/`mine`/`reuse` 必须是**我自己的话**，不是摘要复述——这是"笔记"与"摘抄"的分界。
- 构建：`scripts/build_note.py --pages 2|1`。详细见 `core/note.md`。
