# S6 重聚焦：批注驱动 v2

**目标**：让图变成"用户视角的图"，且每一处改动都能解释。

**这是确定性的活，主要不靠模型。** 模型只负责被批注节点的"解读一句话"，不负责对齐和打分。

## 1. 对齐（脚本，`scripts/refocus.py`）

按优先级三级匹配：

1. **几何**：批注 `rects`（左上原点）与节点 `bbox` 有交叠，且同页。取交叠面积最大者。
2. **文本**：`annotation.text` 与节点 `quote` 归一化后相似度 ≥ 0.75（去标点、小写、去连字符）。
3. **无法匹配** → 新建节点：`kind=user_note`、`text` 取批注前 40 字、`quote` 用批注原文、`page=page_index`、`from_annotation=<key>`。

一个批注可挂多个节点（`nodes[]`），但必须有一个 `primary`。

## 2. 打分

```
w_i   = color_semantics[color_category].weight          # 0.3–1.0
bonus = min(0.15, 0.05 * (n_annotations - 1))           # 多条批注叠加
cb    = 0.10 if comment else 0                       # 有文字批注
score = min(1.0, max(w_i) + bonus + cb)

importance_v2 = round(0.35 * importance_v1 + 0.65 * score, 2)   # 被批注
importance_v2 = round(importance_v1 * 0.75, 2)                  # 未被批注（整体降温）
```

## 3. 压（prune）

标记 `protected`：所有被批注节点 + 它们在树上的祖先（保证路径不断）。

对未 protected 的节点：

- `importance_v2 < 0.35` 且是叶子 → 删除；
- 有子节点 → 折叠：把子节点 `text` 拼成父节点 `detail` 的一条 bullet，子节点删除；
- 论文级关键节点（`kind=limitation`、`kind=gap`）即使低分也保留，权重降到 0.3。

目标：v2 节点数 25–55。不要删到 < 20，否则失去上下文。

## 4. 提（expand）

对被批注但 `detail` 为空的节点：从 `pages.jsonl` 取该页相邻 1 个块（前后各一）补上下文，写进 `detail`，标注 `context_from: "p.N ±1 block"`。

对 `unmatched` 批注：如果它落在图表区域（与 `figures.bbox` 交叠），挂到对应 `F`；否则保留为 `user_note` 并标 `unmatched_reason`。

## 5. diff（给人看，必须写）

`diff.v2.json`：

```json
{
  "schema": "diff/1",
  "from": "v1", "to": "v2",
  "counts": { "nodes_v1": 47, "nodes_v2": 38, "added": 5, "boosted": 12, "demoted": 9, "removed": 14, "merged": 6 },
  "boosted": [{ "id": "N12", "from": 0.55, "to": 0.97, "why": "Red 批注 + 有文字批注" }],
  "added":   [{ "id": "N61", "text": "峰值前 b 值下降 18%", "why": "批注未匹配到 v1 节点" }],
  "demoted": [{ "id": "N03", "from": 0.8, "to": 0.6, "why": "未被批注，整体降温" }],
  "removed": [{ "id": "N22", "text": "…", "why": "未批注且低于阈值" }],
  "merged":  [{ "into": "N05", "from": ["N22", "N23"] }]
}
```

`why` 必须是机器可核对的事实（批注 key、颜色、分数），不是"重要性较低"这种空话。

## 6. 重渲染 v2

```bash
$PY scripts/kmap2mmd.py --knowledge knowledge.v2.json --out-dir maps/v2 --config templates/kmap.config.json
$PY scripts/render_maps.py --dir maps/v2 --config templates/mermaid.json --png
```

高亮规则：被批注节点 `hot`；Red 批注 / 有 comment 的节点 `hot2`；`user_note` 用虚线边框。

领域口径（可选）：给节点/解读挂字典术语（如"峰后形状类""RA-AF 拉裂"），判据引公式不引口语——`$PY scripts/domain.py --query "<关键词>"`。

## 7. 自检

- 被 Red 批注的节点 100% 出现在 v2（缺一个都算失败）；
- `unmatched` 占总批注 ≤ 10%，且每条在汇报里有一句解释；
- 每个 `added` 节点都能指回一条批注 key；
- 图里 `hot` 节点数与 `boosted` 数量级一致（±3）。

## 汇报模板

> v2 完成：47 → 38 节点，提升 12、新增 5（都是你标了但原文没强调的细节）、删除 14（未被批注且低分）。红标 7 条全部保留并置顶，其中 2 条原 v1 没覆盖，已补节点。有 1 条批注落在参考文献，标了 `reference`。图在 `maps/v2/`，要现在做 PPT 吗？
