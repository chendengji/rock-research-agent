# 三库结构：模板库 / 工具库 / 材料库

技能不是"一条写死的流水线"，而是**三个可选资源库**。LLM 使用时**自主选用**（红线贯穿）——从模板库获得方向与结构选择项、从工具库挑方法、参考材料库范例，但具体怎么总结、骨架怎么分、挖掘多深，LLM 自主（由论文自身逻辑决定）。

## 红线层（贯穿三库，不可协商）

- 禁止无出处断言；节点必须有 `page` + `quote`；`reliability` 必标（fact / inference / prior）
- 见 `contracts.md`（schema）+ `quality-gates.md`（质量门）
- 红线是**过滤器**：库里每个元素、LLM 每句产出都要过红线，不编造。

## 模板库（Structure）——拆解思路 / 结构骨架

| 库项 | 位置 | 说明 |
|---|---|---|
| 方向性清单（L1） | `stages/s3-kmap.md` §3C | 综述/试验/数值/理论/案例各一段"值得找的方向"，弱引导可混合可增删，**不设固定分节** |
| 图映射 | `core/maps.md`、`core/principles.md` §2 | 按拓扑特征选图（分支多→tree、阶段序→timeline、流程链→flow、层级清晰→hierarchy），画像作弱先验，可换 |
| schema + 预算 | `templates/*.schema.json`、`kmap.config.json` | 节点/边/flow/glossary/gaps 结构 + budget（depth/tree_children/tree_per_section/flow_steps） |

→ **结构层**：LLM 从库里选骨架，不写死任何一条路径。

## 工具库（Tool）——提取方法 / 分析手段

| 库项 | 位置 | 说明 |
|---|---|---|
| 三遍读法 | `core/principles.md` §0 | 第一遍定位（问题/gap/主张/新鲜在哪），第二遍按论文自身逻辑深读，第三遍核对证据 |
| 理解提示词（核心资产） | `stages/s3-kmap.md` §3 | A 定位骨架 + B 深读抽取（判断句标准/机理/条件/三种话区分 + 经验教训）+ C 方向性清单 |
| 作者总结句优先 | `stages/s3-kmap.md`、`core/examples.md` | 综述先找作者现成观点句（quote 逐字），没有才 LLM 归纳 |
| 提取自查清单 | `stages/s3-kmap.md` §3C/§5 | gap 优先引言缺口 / validation 双核 / 关键数值进 text / conclusion 提机理总结（柔性自查） |
| 可靠性三档 | `core/contracts.md` | fact（原文直接陈述）/ inference（由事实推理）/ prior（基于知识） |
| 按需加载 | `SKILL.md` §3 | 一次只读需要的库文件，不整读 |

→ **结构层+内容层**：LLM 选方法；方法**内部**怎么用（挖掘多深、措辞）完全自主。

## 材料库（Material）——范例 / 参考素材

| 库项 | 位置 | 说明 |
|---|---|---|
| 节点范例 | `core/examples.md` | author 总结句 / 关键数值 / 机理句 各 1–2 例，带 page+quote+reliability |
| 术语表 / 领域字典 | `core/domain.md` | MPZ / SED / 岩爆 / 断裂力学 / 真三轴 / AE 等 |
| 交付范例 | `core/deck.md`、`core/note.md` | 组会 PPT / 一页笔记的范例结构 |
| 图渲染范例 | `templates/*.mmd` | tree / flow / hierarchy / mindmap 的 mmd 骨架 |

→ **内容层**：LLM 参考范例（看"好的节点长什么样"），产出完全自主。

## 三级配合

- **红线层**：贯穿三库，每库元素、每句产出都要可追溯（page/quote/reliability），不编造。
- **结构层**：模板库 + 工具库选择项，LLM 自主选用。
- **内容层**：材料库范例参考 + LLM 自主总结（深浅 / 措辞 / 判断哪个结论重要）。

**遗漏的根因是引导不足，不是约束不足**——所以补库（更多选择项 + 自查清单），而非加硬约束。硬约束会逼 LLM 硬凑、僵化；库 + 自查让 LLM 自己挖到，且灵活。
