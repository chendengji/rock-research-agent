# 子功能：领域字典（rock-mechanics 接入）

**定位**：rock-mechanics 的领域知识（8 个方向）**接入 paper-kmap 作为一个子功能**。它是一份"领域口径"字典——给模型提供术语、判据、公式、分类的统一说法，让论文知识抽取/解读/做 PPT 时**不自己造名词、不乱用公式**。

与组会 PPT、笔记型 PPT 并列，但它是**只读知识源**，不产生文件：

- **数据源**：`scripts/domain.py`（机器可读、唯一来源，避免两份字典漂移）。
- **来源**：原 `skills/rock-mechanics` 已并入本子功能（物理移除，内容在 `scripts/domain.py`，忠实编码 8 方向）。

## 1. 单独用（不需要读论文）

```bash
$PY scripts/domain.py --list          # 8 个领域
$PY scripts/domain.py --area rockburst  # 看岩爆详情（判据/分类/监测）
$PY scripts/domain.py --query "脆性"   # 跨领域检索
```

示例 `--area rockburst` 输出：

```
rockburst — 岩爆（Rockburst）
  分类：
    - strainburst / pillar burst / fault-slip burst
  判据：
    - σθ/σc（洞壁切向应力 / 单轴抗压强度）
    - W_et（弹性应变能指数）
    - Burst Liability Index（冲击倾向指标）
  ...
```

## 2. 各环节调用（读论文/总结/绘图/做PPT/分析）

paper-kmap 的每个阶段都可以先注入领域口径，再让模型干活。**注入的是术语与判据口径，不是论文内容**：

| 环节 | 什么时候调 | 命令 |
|---|---|---|
| s2 解析版面 | 识别方法/实验类型时 | `domain.py --prompt --area-filter dynamic-fracture,rockburst` |
| s3 理解抽取 | **节点命名前必调**（最重要） | `domain.py --prompt`（或按论文主题过滤） |
| s4 画图 | 图内标签用标准术语 | `domain.py --prompt --area-filter <相关>` |
| s5/s6 批注回流 | 解读批注、归类判据时 | `domain.py --query "<批注关键词>"` |
| s7 组会 PPT | claim 表述与论文口径对齐 | `domain.py --prompt --area-filter <相关>` |
| s7 笔记型 PPT | `mine`/`reuse` 引用判据/公式 | `domain.py --area <相关>` |

`--prompt` 输出可直接粘进阶段提示词骨架，作为"领域口径"块（见 `stages/s3-kmap.md`）。

## 3. 命名纪律（写进提示词）

1. **用标准术语**：知识节点 `text`/`glossary` 里的领域词必须来自字典（如"峰后形状类脆性指标""RA-AF 拉裂/剪切"），禁止自造名词。
2. **判据/公式直接引用**：如"σ_θ/σ_c""W_et""Hoek-Brown (2002)"，不重述、不省略下标。
3. **区分领域词与论文词**：字典术语是"口径"；论文自己的参数名（如某指标 B48）仍是论文词，节点里两者都写（`text` 用论文词，`glossary` 挂字典术语）。
4. **拿不准就查**：节点要引用的判据/公式不在字典里 → 先 `--query` 确认，查不到就标"未收录"并在 `glossary` 里写明，不要硬套相近术语。

## 4. 与原 rock-mechanics 技能的关系

- `rock-mechanics` 原先是纯字典（只有 SKILL.md，无脚本/产物）。现已**并入本子功能并物理移除**：数据源唯一在 `scripts/domain.py`。
- 内容一致：`domain.py` 忠实编码了原 8 个方向（岩爆/断裂/隧道/破坏准则/真三轴/AE/动态断裂/水弱化），并加了少量交叉引用注记（如"岩爆倾向判据与脆性指标联用"）。
- 后续字典内容改动**只改 `domain.py`**（唯一来源，无第二份漂移）。

## 5. 校验

```bash
$PY python -c "from scripts.domain import AREAS, search; \
  assert len(AREAS)==8; assert search('脆性'); print('domain ok:', len(AREAS), 'areas')"
```
