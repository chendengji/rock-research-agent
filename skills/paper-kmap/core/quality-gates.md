# 质量闸门

每阶段结束必须过对应闸门。**失败不进下一阶段**；修不了就降级并明确告知用户，不许静默放行。

| 闸门 | 检查 | 命令 | 通过标准 |
|---|---|---|---|
| **G1 素材** | PDF 可打开、页数对、非扫描件 | `validate.py --level source` | 文本 ≥ 200 字符/页；页数与 `layout` 一致 |
| **G2 结构** | JSON 合法、id 唯一、枚举合法 | `validate.py --level kmap` | 0 error |
| **G3 证据** | 每条 quote 能在对应页找到 | `validate.py --level evidence` | 可回溯率 ≥ 95%，其余标 `unverified` |
| **G4 预算** | 节点/层数/子节点数 | `validate.py --level budget` | ≤ 60 节点、≤ 4 层、≤ 6 子/父（**渲染可读性规范，超限为 warn**：在 S4 聚合/分视图解决，**不回退删认知层节点**；只有父子环是 error） |
| **G5 图** | SVG 无 foreignObject、有 viewBox、文字存在 | `render_maps.py` 自动检查 | 全 0 / 全有 |
| **G6 批注** | 条数与 Zotero 一致、每条有归属 | `validate.py --level annotations` | 总数相等；`unmatched ≤ 10%` 且每条有原因 |
| **G7 回流** | diff 非空、v2 未丢关键节点 | `validate.py --level refocus` | 被 Red 批注节点 100% 保留；diff 有 added/boosted |
| **G8 成稿** | 页数、备注、图源、溢出 | `validate.py --level deck` | 每页有 notes；每图存在；无空占位 |
| **G9 人工** | 用户确认 | — | 用户说"可以"才算完 |

## 常用检查片段

```bash
# G3：引文回溯率
$PY scripts/validate.py --paper-dir . --level evidence

# G4：预算
$PY scripts/validate.py --paper-dir . --level budget

# G5：SVG 健康度
grep -L viewBox maps/v1/*.svg          # 输出为空才合格
grep -l foreignObject maps/v1/*.svg    # 输出为空才合格

# G6：批注水位
jq '.stats' annotations.json
jq '.annotations_seen' manifest.json
```

## 已知会失败的情形

| 现象 | 判定 | 处理 |
|---|---|---|
| 引文回溯率 80–95% | 公式/希腊字母/连字符被 PDF 拆开 | 归一化后仍失败 → 标 `unverified`，不阻断 |
| 引文回溯率 < 80% | 抽错了页或语言不匹配 | 回 S2 重解析，不要继续 |
| 批注 rect 全空 | 读到了 Web API 而非本地库 | 确认 `ZOTERO_LOCAL=true`，改用 `ann_geom.py` 直接读库 |
| `unmatched` 30% | 对齐算法没跑或阈值太严 | 先做 rect ∩ bbox，再退回文本匹配 |
| 脑图节点 > 80 | 没聚合 | 按 `core/maps.md` 第 4 节聚合，不许缩字号 |
| deck 图空白 | SVG 未插入或 foreignObject | 查 `svgplan.json` 与 PNG 降级 |

## 每次交付附一句话

> 闸门：G2/G3/G4/G5 通过（回溯率 97%，2 条 unverified）；G6 有 1 条批注落在参考文献区，已标 `no_node`。
