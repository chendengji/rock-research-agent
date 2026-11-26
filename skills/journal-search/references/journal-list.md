# Journal Search — 期刊优先级映射表

从 `岩石力学Zotero订阅清单.md` 提取的期刊优先级数据。

## 期刊分级 (Tier)

| Tier | 分数 | 类别 | 说明 |
|------|------|------|------|
| Tier 0 | 35 | A. 岩石力学核心 | 学科最核心的四本期刊 |
| Tier 1 | 28 | B. 岩土工程核心 | 岩土力学与岩土工程方向 |
| Tier 2 | 20 | C. 工程地质与灾害 | 工程地质、滑坡、地质灾害 |
| Tier 2 | 20 | D. 地下工程与隧道 | 隧道与地下空间 |
| Tier 2 | 20 | E. 断裂力学与动力学 | 岩石断裂、土动力学 |
| Tier 2 | 20 | F. 能源岩土力学 | 地热、封存、地下储能 |
| Tier 3 | 25 | G. 中文核心——三岩 | 国内岩石力学与岩土工程三大核心刊 |
| Tier 4 | 10 | 附：其他中文期刊 | 已订阅，按需保留 |
| Tier 5 | 0 | 非清单期刊 | 不在订阅清单中的期刊 |

## 期刊名称 → 缩写 → 分级 映射

### Tier 0 — 岩石力学核心 (35 分)

| 序号 | 全称 | 缩写 | ISSN | 出版商 |
|------|------|------|------|--------|
| 1 | Rock Mechanics and Rock Engineering | RMRE | 0723-2632 | Springer |
| 2 | International Journal of Rock Mechanics and Mining Sciences | IJRMMS | 1365-1609 | ScienceDirect |
| 3 | Acta Geotechnica | AG | 1861-1133 | Springer |
| 4 | Journal of Rock Mechanics and Geotechnical Engineering | JRMGE | 1674-7755 | ScienceDirect |

### Tier 1 — 岩土工程核心 (28 分)

| 序号 | 全称 | 缩写 | ISSN | 出版商 |
|------|------|------|------|--------|
| 5 | Computers and Geotechnics | CG | 0266-352X | ScienceDirect |
| 6 | Geotextiles and Geomembranes | — | 0266-1144 | ScienceDirect |
| 7 | Geotechnique | — | 0016-8505 | ICE Publishing |
| 8 | Journal of Geotechnical and Geoenvironmental Engineering | JGGE | 1090-0241 | ASCE |
| 9 | International Journal of Geomechanics | IJOG | 1532-3641 | ASCE |
| 10 | International Journal for Numerical and Analytical Methods in Geomechanics | NAG | 0363-9061 | Wiley |
| 11 | Canadian Geotechnical Journal | CGJ | 0008-3674 | ScienceDirect |
| 12 | Soils and Foundations | — | 0038-0806 | ScienceDirect |

### Tier 2 — 工程地质与地质灾害 (20 分)

| 序号 | 全称 | 缩写 | ISSN | 出版商 |
|------|------|------|------|--------|
| 13 | Engineering Geology | EG | 0013-7952 | ScienceDirect |
| 14 | Landslides | — | 1612-510X | Springer |
| 15 | Bulletin of Engineering Geology and the Environment | BEGE | 1437-6282 | Springer |

### Tier 2 — 地下工程与隧道 (20 分)

| 序号 | 全称 | 缩写 | ISSN | 出版商 |
|------|------|------|------|--------|
| 16 | Tunnelling and Underground Space Technology | TUST | 0886-7798 | ScienceDirect |

### Tier 2 — 断裂力学与动力学 (20 分)

| 序号 | 全称 | 缩写 | ISSN | 出版商 |
|------|------|------|------|--------|
| 17 | Engineering Fracture Mechanics | EFM | 0013-7944 | ScienceDirect |
| 18 | Soil Dynamics and Earthquake Engineering | SDEE | 0267-7261 | ScienceDirect |

### Tier 2 — 能源岩土力学 (20 分)

| 序号 | 全称 | 缩写 | ISSN | 出版商 |
|------|------|------|------|--------|
| 19 | Geomechanics and Geophysics for Geo-Energy and Geo-Resources | G4 | 2363-4357 | Springer |

### Tier 3 — 中文核心·三岩 (25 分)

| 序号 | 全称 | 缩写 | 收录 | 出版商 |
|------|------|------|------|--------|
| 20 | 岩石力学与工程学报 | — | EI/CSCD | 万方 |
| 21 | 岩土力学 | — | EI/CSCD | 万方 |
| 22 | 岩土工程学报 | — | EI/CSCD | 万方 |

### Tier 4 — 其他中文期刊 (10 分)

| 序号 | 全称 | 缩写 | 收录 | 出版商 |
|------|------|------|------|--------|
| 23 | 土木工程学报 | — | EI/CSCD | 万方 |
| 24 | 工程地质学报 | — | CSCD/北大核心 | 万方 |
| 25 | 煤炭学报 | — | EI/CSCD | 万方 |
| 26 | 水利学报 | — | EI/CSCD | 万方 |

## 搜索路由策略

| 期刊类型 | 搜索途径 | 备注 |
|---------|---------|------|
| Tier 0-2 国际期刊 | `journal_search` 工具 (CrossRef + OpenAlex + Semantic Scholar) | 数据商覆盖完整，DOI 全覆盖 |
| Tier 3 中文期刊 | `journal_search` 覆盖有限，可把期刊名加入 query 初筛 | 正式检索建议在 CNKI/万方进行 |
| Tier 4 其他中文 | 同上 | 或提示用户去 CNKI/万方手动检索 |
| 非清单期刊 | `journal_search` 一并返回，但降权展示 | 不遗漏，但有优先级差异 |

## 别名映射 (供自然语言解析用)

```
"RMRE" / "Rock Mech Rock Eng" → Rock Mechanics and Rock Engineering
"IJRMMS" / "Int J Rock Mech Min" → International Journal of Rock Mechanics and Mining Sciences
"JRMGE" / "J Rock Mech Geotech" → Journal of Rock Mechanics and Geotechnical Engineering
"AG" / "Acta Geotech" → Acta Geotechnica
"CG" / "Comput Geotech" → Computers and Geotechnics
"JGGE" / "J Geotech Geoenviron" → Journal of Geotechnical and Geoenvironmental Engineering
"IJOG" / "Int J Geomech" → International Journal of Geomechanics
"NAG" / "Int J Numer Anal Meth" → International Journal for Numerical and Analytical Methods in Geomechanics
"CGJ" / "Can Geotech J" → Canadian Geotechnical Journal
"EG" / "Eng Geol" → Engineering Geology
"TUST" / "Tunn Undergr Sp Tech" → Tunnelling and Underground Space Technology
"EFM" / "Eng Fract Mech" → Engineering Fracture Mechanics
"SDEE" / "Soil Dyn Earthq Eng" → Soil Dynamics and Earthquake Engineering
"BEGE" / "Bull Eng Geol Environ" → Bulletin of Engineering Geology and the Environment
"G4" / "Geomech Geophys Geo-Energy" → Geomechanics and Geophysics for Geo-Energy and Geo-Resources
"三岩" → 岩石力学与工程学报, 岩土力学, 岩土工程学报
"岩石力学与工程学报" / "岩石学报" → 岩石力学与工程学报
"岩土力学" → 岩土力学
"岩土工程学报" → 岩土工程学报
```