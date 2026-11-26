# S2 读原文（本地文献库，不走 Zotero MCP）

**目标**：拿到"可被引用的逐页全文 + 可裁剪的图框"。

**读原文走本地**：直接读 `paper-raw/<citekey>.json` 的 `pages[].text`（ingest 已解析逐页全文）。**不调 zotero-cli、不复制 PDF**。仅当需要 bbox 定位引用或裁剪图/表时，才用源目录 PDF（用户给或源目录找，可选）。

## 1. 读指定部分 or 全文（用户决定）

- 用户说"读引言 / 方法 / 第 3 节 / 某页" → 只读对应章节/页；
- 用户没说 → **读全文**（默认）。

读法（两种，按需）：

```bash
# A. 读结构摘要（标题/作者/年份/摘要/页数/参考文献/章节）
paper_read "<citekey>"

# B. 读逐页全文：paper-raw/<citekey>.json 的 pages[].text（每页 {number,text,has_tables,has_figures}）
#    - 全文：所有 pages
#    - 指定部分：按页 number 或文本关键词过滤
```

若 JSON 章节信息不足（学位论文 `sections` 常为空）→ 用页文本 + 标题启发式分节（交给 S3 骨架）。

## 2. 引用定位（bbox）与图/表框（需要时）

只有要给证据标精确 bbox 或裁剪图/表时才需要 PDF（本地模式 PDF 可选）：

```bash
# bbox：从 PDF 转逐页文本块（paper-raw JSON 只有页面级 text，无块级 bbox）
$PY scripts/pdf_pages.py --pdf <源目录/paper.pdf> --out source/pages.jsonl

# 图/表框 + caption（需 PDF；本地模式无 PDF 则跳过，图信息用 JSON 的 has_figures/caption）
$PY scripts/figures_extract.py --paper-dir .
```

## 3. 中间数据

读原文的中间产物写到 `paper-reading/<citekey>/source/`（不碰 `paper-raw/`，只读不改）。

## 自检

- 能读到章节文本；引用的句能在对应页找到（bbox 对齐）；
- 读原文全程**未调 zotero-cli**（除非用户明确要批注回流 s5）。

## 坑

- paper-raw JSON 只读、不改；中间数据写到 paper-reading/<citekey>/source/。
- 学位论文（93 页）文本量大 → **分段读**，别一次全喂（长上下文注意力衰减，S3 铁律）。
- 需要 bbox 定位时才用 pdf_pages.py；只读文本直接走 pages[].text。
