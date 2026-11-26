# S5 取批注与截图

**目标**：把 Zotero 里的高亮、框选图、文字批注，变成"带精确位置和权重的结构化数据"。

## 步骤

1. **先问颜色语义（只在第一次问）**

   > 你的高亮颜色是按什么分的？比如红=核心结论、橙=重要图、蓝=方法？

   写进 `templates/kmap.config.json` 的 `color_semantics`。用户说"随便标的"→ 全部按 `general` 0.5，但要在汇报里说明"颜色未区分，权重靠位置和密度"。

2. **拉批注（语义字段）**

   ```bash
   zotero-cli --json annotations list --item-key <ITEMKEY> > annotations.raw.json
   ```

3. **补几何（rects）**

   ```bash
   $PY scripts/ann_geom.py \
     --item-key <ITEMKEY> --pdf source/paper.pdf --out annotations.json
   ```

   脚本会把 `annotations.raw.json` 的语义字段与库里读出的 `position` 按 `annotation_key` 合并；如果没先跑第 2 步，它会自己查库补全。

4. **截图**

   ```bash
   $PY scripts/crop_annotations.py --paper-dir . --margin 0.012
   ```

   - 默认只截 `type=image`（用户亲手框的图，优先级最高）；`--all` 连高亮一起截。
   - 脚本自动按 `rects_norm` 外扩、调 `read --rect`、重命名为 `ann/<key>.png` 并回写 `crop`。
   - 高亮批注进 PPT 时优先排原文；截图只在"原文脱离上下文就看不懂"时用。

5. **统计并写回 annotations.json**

   ```json
   "stats": { "total": 19, "highlight": 16, "image": 3, "with_comment": 2, "unmatched": 0 }
   ```

   `total` 必须与 `annotations list` 的条数一致；不一致说明合并键错了。

6. **更新 manifest**：`stage=annotations`、`annotations_seen=<total>`、`annotations_modified=<max modified>`。

领域口径（可选）：解读批注、归类判据时用字典术语——`$PY scripts/domain.py --query "<批注关键词>"`。

## 自检

```bash
jq '.stats' annotations.json
jq '.items | length' annotations.json
```

- 每条 `image` 都有 `crop` 且文件存在、体积 > 5 KB；
- `rects_norm` 全部在 `[0,1]` 内、`w,h > 0`；
- `page_index` 与 `page_label` 同时存在（前者算几何，后者给人看）。

## 坑

| 现象 | 原因 | 处理 |
|---|---|---|
| rects 全空 | 走了 Web API 或 Electron 缓存 | 用 `ann_geom.py` 直读本地库副本 |
| 截图全白/全黑 | `--start-page` 用了 0 基 | `page_index + 1` |
| 截到半页 | rect 是 PDF 左下原点 | 用 `rects_norm`，不要用 `rects` |
| 图片批注 `text` 为空 | 正常，框选没有文字 | 靠 `rects` + 邻近 caption 判断内容 |
| 批注在参考文献区 | 用户标了引用 | 保留，但 `kind=term` 或 `unmatched:reference` |

## 汇报模板

> 取到 19 条批注（16 高亮 / 3 框选图 / 2 条有文字），截图 3 张。颜色分布：红 7、黄 8、橙 3、紫 1。按你的规则，红=核心结论。现在重排 v2。
