# 材料库：节点范例

好的节点长什么样——**带 page + quote + reliability**，供 LLM 参考（自主选用，非硬性照抄）。范例来自演练验证过的三篇（牛腾飞 试验 / Meng 综述 / Yang 数值模拟）。

## 1. 作者总结句（综述，fact）

综述找"作者总结的句子"（现成观点句），quote 逐字，reliability=fact：

```json
{ "id": "N04", "kind": "claim", "section": "S2", "text": "按参数/测量方法分 11 类（作者总结）",
  "detail": "含多参数的指标按主参数归类", "page": 2,
  "quote": "The indices can be roughly categorized into 11 groups based on the parameters or measurement methods involved",
  "reliability": "fact", "importance": 0.95 }
```

要点：text 是**判断句**（含结论），quote 是**原文逐字**，page 是出处页码。

## 2. 关键数值（试验/数值模拟，fact）

关键定量结果要进 `text`（图可见），不只 detail（图不渲染 detail）：

```json
{ "id": "N21", "kind": "result", "section": "S4", "text": "暴露时间量化：0→30s 破坏单元 430→93",
  "detail": "30s 破碎区径向长约 A0 一半；A3 最弱(93单元/1.58m)", "page": 11,
  "quote": "the number of failed elements decreased from 430 to 93",
  "reliability": "fact", "importance": 0.85 }
```

要点：数值（430→93）在 text，一眼看到结论+量级；detail 放补充。

## 3. 机理句（结论/分析，fact 或 inference）

结论的"功能/机理总结"必须提，不只"可行/有效"：

```json
{ "id": "N25", "kind": "conclusion", "section": "S6", "text": "MPZ 两大功能：①卸压区降应力+储能极限提高 ②应力波反射降传递效率",
  "detail": "核心机理：卸压区降低巷道应力+岩石需更多能量达储能极限；MPZ 边界反射降应力波传递", "page": 17,
  "quote": "a destressed zone below the MPZ reduces the stress level...the MPZ deformation and stress wave reflection at the boundary...reduction of stress transmission efficiency",
  "reliability": "fact", "importance": 0.95 }
```

要点：机理是**结论层**的（原文明确总结），reliability=fact；若为 LLM 推理的机理则 inference。

## 4. 可靠性三档（标注方法）

- `fact`：原文直接陈述（数值/结论/参数/作者总结句）——quote 逐字。
- `inference`：由原文事实推理（机制/归因/因果），原文没直说但逻辑可推。
- `prior`：基于 LLM 既有知识（背景常识/文献常识），本地无直接依据——图里标 UNVERIFIED 风险。

## 5. 术语范例（glossary）

```json
{ "term": "MPZ", "zh": "微波预处理区", "def": "微波照射后岩石改性区" },
{ "term": "SED", "zh": "应变能密度", "def": "单位体积储存应变能" }
```

## 6. 图映射范例（拓扑导向，弱先验）

主图由 knowledge.json **拓扑特征**定（见 `core/principles.md` §2），下例仅示典型情形：

- 分支多且平级（"射线追踪方法众多，各在原理/精度/效率上有特点"）→ tree（知识框架：主题→分支→特点）；有时间脉络加 timeline。
- 流程链明显（材料→设备→加载→采集 / 模型→校准→边界→求解）→ flow；结果分支多时加 tree。
- 推导链（假设→推导→适用条件→验证）→ flow（推导链）；hierarchy 辅助（论证梯 top3）。
- 现场→监测→数据→分析平展开 → tree；监测有先后脉络 → timeline。
