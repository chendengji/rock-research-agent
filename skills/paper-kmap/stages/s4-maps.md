# S4 出图（v1）

**目标**：按 `knowledge.json` 的**拓扑特征**选主图（类型仅作弱先验，见 `core/principles.md` §2）：分支多且平级→`tree`，时间/阶段序强→`timeline`，流程/因果链明显→`flow`，层级分类清晰→`hierarchy`；其余辅助。**先给用户看图，再决定要不要精读**——这是整条流水线的分叉点。

**思维导图（tree.mmd）的本质**：把论文里的**文字内容结构化**成图——中心=主题（如"射线追踪方法"），分支=各方法/要素，子分支=各自特点（原理/精度/效率/问题）。让用户**一目了然**。文章后面介绍更多方法 → 往同一张图加分支（**增量丰富**），不重开图。

## 步骤

1. **生成 Mermaid 源**（确定性脚本，不让模型写）

   ```bash
   $PY scripts/kmap2mmd.py \
     --knowledge knowledge.v1.json --out-dir maps/v1 \
     --config templates/kmap.config.json
   ```

   产出 `tree.mmd`（知识框架·主产出）/ `timeline.mmd`（综述时间脉络，有才产）/ `mindmap.mmd` / `hierarchy.mmd` / `flow.mmd`。脚本负责：预算裁剪、标签截断与转义、`hot` 类、`<br/>` 换行。

   图内标签用领域标准术语（子功能）：`$PY scripts/domain.py --prompt --area-filter <相关>`——`kmap2mmd.py` 只投影 `knowledge.json`，标签措辞在 S3 定，图不造词。

2. **渲染**

   ```bash
   $PY scripts/render_maps.py \
     --dir maps/v1 --config templates/mermaid.json --png
   ```

   产出 `*.svg` + `*.png` + `render.log`。`--png` 只用于预览与降级。

3. **肉眼验收**（必须做，脚本查不出重叠）

   打开 `maps/v1/*.png`，逐张问：

   - 3 秒内能不能说出这张图的主线？
   - 有没有节点文字压线、箭头穿字、中文方框？
   - 有没有"看不懂但显得很专业"的节点？有就删。

4. **写 5 分钟速览 `README.md`**

   ```markdown
   # <标题>
   **一句话**：<这篇解决了什么，结论是什么>
   **为什么值得读**：<与用户研究方向的关系，1–2 句>
   ## 10 条要点
   1. …（对应节点 N03，p.4）
   ## 图
   - 知识框架（主产出）：maps/v1/tree.svg
   - 时间脉络（综述类，按需）：maps/v1/timeline.svg
   - 脑图：maps/v1/mindmap.svg
   - 论证：maps/v1/hierarchy.svg
   - 方法：maps/v1/flow.svg
   ## 我的判断
   - 可用：…
   - 存疑：…
   ```

5. **更新 manifest**：`stage=maps`，记录四张图的节点数。

## 自检

```bash
grep -l foreignObject maps/v1/*.svg    # 必须为空
grep -L viewBox maps/v1/*.svg          # 必须为空
```

- 脑图分支 4–6，层级 ≤ 4；
- 层次图每个 rank ≤ 4 节点；
- 流程图 ≤ 9 步；
- SVG 宽高比 1.3–1.9。

## 分叉：问用户一句

> v1 图在 `maps/v1/`。你要是打算精读，就去 Zotero 标；标完跟我说一声，我按批注重做一版（会突出你标的、删掉你没标的）。不精读的话，现在就可以收尾。

不要自作主张直接做 PPT——用户可能只是想知道这篇值不值得读。

## 坑

- mindmap 标签里出现 `(` `)` `[` `]` 会解析失败 → 脚本已过滤，手改时注意。
- 节点太多导致图很宽 → 先聚合，别改 `--size`。
- 中文字体缺失会渲染成方框 → `themeVariables.fontFamily` 必须是本机有的字体（`Microsoft YaHei`）。
