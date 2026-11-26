# S1 定位与建档（本地文献库，读原文不碰 Zotero MCP）

**目标**：把用户给的引用/标题/文件名变成"确定的一篇 + 可读的解析文本"。**优先本地文献库**；未入库才让用户给文件地址。

用户输入形如：`[1] 牛腾飞. 双轴压缩下倾斜孔洞岩石的裂纹扩展特性与声发射定位研究[D]. 中南大学，2024.` —— 从中取作者/年份/标题关键词去检索。

## 1. 先检索是否入库（本地文献库）

文献库 = `$ROCK_PROJECT_ROOT/paper-raw/`（每篇一个 `<年份> - <作者> - <标题>.json`，ingest 解析文本，含逐页全文 `pages[].text`）。

- 检索（两路并行）：
  ```bash
  paper_search "<作者> <标题关键词>"          # RAG 检索（走 rag_query.mjs 子进程）
  ls "$ROCK_PROJECT_ROOT/paper-raw/" | grep -iE "<作者|标题关键词>"   # 文件系统兜底（中文更稳）
  ```
- **命中** → 直接读 `paper-raw/<citekey>.json`，跳 S2 读取（**不需要建档、不需要复制 PDF**）。
- **未命中** → 步骤 2。

## 2. 未入库 → 用户给文件地址

用户直接告诉你 PDF 路径（如 `D:/Papers/niu2024.pdf`）：

```bash
ingest_pdf.py "D:/Papers/niu2024.pdf" --output "$ROCK_PROJECT_ROOT/paper-raw/"
# 可选：建索引，让 paper_search 下次能检索到
node --experimental-strip-types --no-warnings "$SK/../support/scripts/rag-rebuild/rag_rebuild.mjs" --clean
```

ingest 产出 `<年份> - <作者> - <标题>.json`，之后走 S2 读取。用户没给地址 → 提示提供（报错，不猜、不编造）。

## 3. 出图/PPT 才建档（不复制 PDF，只记路径）

纯读+出图，用 `<LIB>/paper-reading/<citekey>/`（本地模式，不碰 Zotero、**不复制 PDF**）：

```bash
SK="$HOME/.pi/agent/packages/rock-research-agent/skills/paper-kmap"  # 或 $ROCK_AGENT_PKG/skills/paper-kmap
$PY scripts/init_reading.py \
  --json "$ROCK_PROJECT_ROOT/paper-raw/<citekey>.json" --lib "$ROCK_PROJECT_ROOT"
```

产物（只存中间过程数据 + 图，**无 source/paper.pdf**）：
```
<LIB>/paper-reading/<citekey>/
├── manifest.json      # 状态机（记 json 路径，pdf_copied=false）
├── source/pages.jsonl # 页文本 + bbox（从 PDF 转出，仅需引用定位时）
├── knowledge.v1.json  # 冷读结果
├── figs/ ann/ maps/v1 maps/v2 deck logs
```

## 4. 走批注回流时（做 PPT/笔记，M2/M3/M4）才用 Zotero MCP

**读原文、做图不用 Zotero**；只有当用户要"把我在 Zotero 里给文章做的批注（注释）回流"（做 PPT/笔记/精读回流）时，才走 `zotero-cli` 读批注（见 s5）。此时 init_reading 用 `--item-key`（Zotero 模式）。

## 自检

- 命中 → 有 `<citekey>.json`；未命中 → ingest 成功产出 JSON；
- manifest 关键字段（citekey/title/json/pdf_copied）齐全，`pdf_copied=false`（本地模式）。

## 坑

- paper-raw JSON 的 `title` 可能是空（CNKI 学位论文 ingest 提取失败）→ 从文件名 `<年份> - <作者> - <标题>` 解析，别依赖 JSON title。
- 中文检索：paper_search 对中文命中差时用 `ls | grep`（作者姓/年份更稳）。
- 学位论文（`[D]`）无 DOI：直接按标题/作者文件系统检索。
- citekey 用短 key（`年份-一作-短标题`），不要用超长文件名。

## 汇报模板

> 已定位：**2024-牛腾飞-双轴压缩下倾斜孔洞岩石**（93 页，已入库，直接读解析文本）。工作目录 `…/paper-reading/2024-牛腾飞-双轴压缩下倾斜孔洞岩石/`。下一步读原文，约 1 分钟。
