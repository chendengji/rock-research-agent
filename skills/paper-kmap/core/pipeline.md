# 流水线：阶段、状态机、幂等

## 阶段表

| 阶段 | 目的 | 主要动作 | 产物 | 退出条件 |
|---|---|---|---|---|
| **S1** resolve | 定位论文 | `zotero-cli search/get/path`，建目录 | `manifest.json` | item_key + PDF 可打开 |
| **S2** read | 解析版面 | `pdf_pages.py` + `zotero-cli layout` | `pages.jsonl`, `figures.json` | 每页有文本、图表有 caption |
| **S3** kmap | 理解成结构 | 骨架 → 分节抽取 → 合并 | `knowledge.v1.json` | validate `kmap` 通过 |
| **S4** maps | 出四张图（结构树为主 + 脑图/层次/流程辅助） | `kmap2mmd.py` + `render_maps.py` | `maps/v1/*` | 无 foreignObject、预算内 |
| **S5** annotations | 取批注与截图 | `annotations list` + `ann_geom.py` + `read --rect` | `annotations.json`, `ann/*.png` | 条数与 Zotero 一致 |
| **S6** refocus | 批注驱动重排 | 对齐 → 打分 → 压/提 → diff | `knowledge.v2.json`, `diff.v2.json`, `maps/v2/*` | 未匹配 ≤ 10% 且逐条说明 |
| **S7a** note 笔记（先） | 一页/两页个人笔记 | `note.json` → `build_note.py` → QA | `note/note-{1p,2p}.pptx` | 质量闸门全绿 |
| **S7b** deck 组会（后） | 组会汇报成稿 | `deck.json` → `build_deck.py` → QA | `deck/deck.pptx` | 质量闸门全绿 |

> 顺序：**先做笔记 PPT（S7a），再做组会 PPT（S7b）**——笔记是个人消化沉淀，组会是向他人汇报。

S5 与 S2 可并行；S4 与 S6 之间必须有一次人工确认（用户看一眼 v1 图再决定是否值得精读）。

## 状态机（manifest.json）

```json
{
  "schema": "manifest/1",
  "citekey": "2021-Meng-brittleness",
  "item_key": "FKG6YS2W",
  "attachment_key": "7V7YN3WD",
  "json": "C:/.../paper-raw/2021-Meng-brittleness.json",  # 本地模式：解析文本主输入
  "pdf": "",  # 本地模式不复制 PDF；Zotero 模式软链到 source/paper.pdf
  "pdf_copied": false,
  "stage": "refocus",
  "done": ["resolve", "read", "kmap", "maps", "annotations", "refocus"],
  "counts": { "pages": 21, "nodes": 47, "figures": 12, "annotations": 19, "unmatched": 1 },
  "annotations_seen": 19,
  "hashes": { "pdf_sha1": "…", "knowledge": "…", "annotations": "…" },
  "updated": "2026-10-30T12:00:00+08:00"
}
```

`annotations_seen` 记的是**已消费**的批注条数（不是库里的总数）。回流判定：

```
current = len(annotations.items)
need_refocus = current > manifest.annotations_seen
             or annotations.max_modified > manifest.annotations_modified
```

## 幂等与断点

- 每个阶段可单独重跑；重跑只覆盖本阶段产物和下游（用 `--from` 语义，脚本自己判断）。
- 缓存键：`pdf_sha1 + prompt_version + model`（S3）；`knowledge_sha1 + annotations_sha1`（S6）。
- LLM 调用把原始响应落到 `logs/llm/<stage>-<hash>.json`，失败可回放，不用重花钱。
- 单篇 12 页论文的预算：S3 约 6–10 次调用（1 次骨架 + 每节 1 次 + 1 次合并），S6 约 1–2 次，S7 约 1 次。超过 15 次说明在重复读全文，停下检查。

## 失败降级

| 情况 | 处理 |
|---|---|
| 扫描件（文本 < 200 字符/页） | 走 `ingest_pdf.py` 的 PaddleOCR GPU，**不要**换 tesseract/CPU |
| 双栏顺序错乱 | `pdf_pages.py` 已做列切分；仍错则按页人工指定 `--order left-right` |
| `layout` 找不到图 | 只用 caption 文本定位（正则 `Fig\.?\s*\d+`），图区域缺失就留空并标注 |
| 批注 rect 缺失（EPUB/旧库） | 用 `annotationText` 在页内模糊搜索定位；再不行标 `unmatched:no_geometry` |
| Zotero 正在运行 | 只读副本（`ann_geom.py` 自动复制主库 + wal），绝不直接写库 |
| 模型输出不是合法 JSON | 带错误信息重试一次；仍失败则降级为"只出骨架 + 人工补节点"，不要瞎编 |
