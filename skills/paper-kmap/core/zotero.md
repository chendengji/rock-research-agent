# Zotero 侧：取批注、取几何、取图

工具已配：MCP `zotero`（`zotero-mcp` 0.15.1，`ZOTERO_LOCAL=true`）+ 独立 CLI `zotero-cli`。
**流水线优先用 CLI**：可脚本化、输出稳定 JSON；MCP 留给交互式追问。

## 1. 命令坑位（实测）

```bash
# ✅ --json 在子命令前
zotero-cli --json annotations list --item-key FKG6YS2W

# ❌ 放后面会 unrecognized arguments
zotero-cli annotations list --item-key FKG6YS2W --json
```

其他已实测可用的：

```bash
zotero-cli --json search "brittleness indices"      # 找 item_key
zotero-cli --json get metadata FKG6YS2W
zotero-cli --json path FKG6YS2W                     # 拿 PDF 绝对路径
zotero-cli --json outline FKG6YS2W                  # PDF 目录（需 PyMuPDF）
zotero-cli --json layout 7V7YN3WD --pages 2-4       # 图/表框 + caption
zotero-cli --json read 7V7YN3WD --start-page 2 --format image --rect "0.09,0.71,0.35,0.15" --out ann/
```

`layout` / `outline` / `read --format image` 依赖 PyMuPDF。若报 `requires PyMuPDF`，修一次即可（不要换别的 PDF 库）：

```powershell
# 用 zotero-mcp 工具环境自己的 pip/uv 补装，路径不写死
pip install pymupdf        # 或 uv pip install --python <该环境python> pymupdf
```

## 2. 批注数据的真实形状

`annotations list` 返回的字段（已归一化）：

```
annotation_key, item_key, attachment_key, parent_title, type, page, page_index,
text, comment, color, color_category, tags, created, modified, source
```

三条必须记住：

1. **`page` 是期刊页码，`page_index` 才是 PDF 页**。实测某条 `page="222"` 而 `page_index=1`。所有几何计算用 `page_index`，给人看用 `page`。
2. **`type=image` 的批注 `text` 为空**：用户框选的是图/表区域，只能靠 `rects`。这类批注恰恰是"用户认为重要的图"，优先级最高。
3. **CLI/MCP 都丢掉了 `annotationPosition`**（rects）。要裁剪必须补一步读库：`scripts/ann_geom.py`。

## 3. 几何：读库补 rect（`ann_geom.py`）

Zotero 库：`~/Documents/Zotero/zotero.sqlite`（可用 `ZOTERO_DATA_DIR` 覆盖）。
Zotero 运行时库被锁 → 脚本先把 `zotero.sqlite` + `-wal` + `-shm` 复制到临时目录再读，**永远不写原库**。

坐标系换算（最容易错的一步）：

```
Zotero position.rects = [x0, y0, x1, y1]，单位 pt，原点在左下
PyMuPDF / PPT 需要原点左上：
  x = x0 / W
  y = 1 - y1 / H
  w = (x1 - x0) / W
  h = (y1 - y0) / H
```

输出 `rects`（原始）与 `rects_norm`（左上原点归一化）两套，后者直接给 `zotero-cli read --rect`。

## 4. 截图

- 批注截图：`zotero-cli read <ATTACH> --start-page <idx+1> --format image --rect "<norm>" --out ann/`
  **注意 `--start-page` 是 1 基**，而 `page_index` 是 0 基，传参时 +1。
- 图片题注截图：`layout` 的 `bbox` 已经是归一化 `[x,y,w,h]`，可直接用。**推荐用 `scripts/figures_extract.py` + `scripts/figures_crop.py`**：前者清洗 layout 出 `source/figures.json`（丢低置信无 caption 碎片、合并多子图、编号 `F1..Fn`、回填 caption、初判 role），后者按 `rect_arg` 裁到 `figs/F<n>.png`。`confidence=low` 且 `caption_label=null` 的框多为多子图碎片，由 `figures_extract.py` 按 y 间距（<0.02）合并到最近的带 caption 锚后再截。
- 截图默认约 150 dpi；PPT 里 1/3 页宽以上时够用，整页大图建议再放大（`read` 不支持 dpi，改用 PyMuPDF 600 dpi 重截）。

## 5. 颜色语义（默认，可改）

实测库里出现的颜色族：Yellow(#ffd400)、Red(#ff6666/#e44234)、Orange(#f19837/#ffcd45)、Blue(#2ea8e5)、Green(#5fb236)、Purple(#a28ae5)、Magenta(#e56eee)。

默认映射（写在 `templates/kmap.config.json`，按**颜色族**不按 hex，兼容 Zotero 调色板变动）：

| 族 | role | weight | 含义 |
|---|---|---|---|
| Red | critical | 1.0 | 核心结论 / 反驳点 |
| Orange | figure | 0.9 | 重要图、表、框选 |
| Green | support | 0.8 | 支持性证据 |
| Purple | question | 0.8 | 疑问、待查 |
| Blue | method | 0.7 | 方法、参数 |
| Yellow | general | 0.5 | 一般高亮（量最大，别当重点） |
| Magenta | idea | 0.6 | 联想到自己的想法 |
| Gray | misc | 0.3 | 杂项 |

第一次跑 M2 前必须问用户一句：**"你的颜色是按什么分的？"** 用户答完写进配置，之后不再问。

## 6. 只读边界

- 不加批注、不改颜色、不删条目、不动 collection。
- 写回（把 v2 摘要存成子笔记）是**可选**动作，需用户明确说"写回"；用 `zotero-cli notes add --item-key <K>`，写前先展示内容给用户确认。
- 不把密钥/路径写进笔记或日志。
