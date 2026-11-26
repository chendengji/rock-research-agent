#!/usr/bin/env python3
"""Build a 16:9 PPTX from deck.json. SVG is inserted via PowerPoint COM when available."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import PP_PLACEHOLDER
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.util import Emu, Inches, Pt

FONT = "Microsoft YaHei"
DARK = RGBColor(0x1F, 0x2D, 0x3D)
MUTED = RGBColor(0x5A, 0x6B, 0x7D)
ACCENT = RGBColor(0x1F, 0x4E, 0x79)
WARN = RGBColor(0xC0, 0x39, 0x2B)
LIGHT = RGBColor(0xEE, 0xF4, 0xFF)

W, H = 13.333, 7.5
MARGIN = 0.65

_TEXT = re.compile(r"<text[^>]*>.*?</text>", re.S)
_EMY = re.compile(r"(?:y|dy)=" + r'"-?[\d.]+em"')


def pptx_safe_svg(svg: str, font_size: float = 16.0) -> str:
    """Make an mmdc SVG render correctly inside PowerPoint.

    Two problems, two fixes:

    1. PowerPoint's SVG engine ignores the CSS rules mermaid puts in <style>
       (``#my-svg .section-N path{...}``), so every node falls back to one dark
       fill and text becomes unreadable. Inline the fill/stroke/stroke-width
       that the CSS would have applied onto each element.
    2. PowerPoint drops ``<text>`` blocks whose line positions are given in em
       units (mindmap emits ``y="1em"`` / ``dy="1.1em"`` on <tspan>), turning
       whole nodes into empty boxes. Flatten such blocks into one plain
       ``<text>`` per line with absolute px y.
    """
    svg = _inline_styles(svg, font_size)
    return _flatten_text(svg, font_size)


def _inline_styles(svg: str, font_size: float) -> str:
    style_m = re.search(r"<style>(.*?)</style>", svg, re.S)
    if not style_m:
        return svg
    rules = []
    for sel, body in re.findall(r"([^{}]+)\{([^}]*)\}", style_m.group(1)):
        sel = sel.strip()
        if not sel or sel.startswith("@media") or sel.startswith("@keyframes") or sel.startswith(":"):
            continue
        props = dict(re.findall(r"([a-zA-Z-]+)\s*:\s*([^;]+);?", body))
        tag = re.search(r"([a-zA-Z]+)\s*$", sel.replace(">", " ").strip())
        tag = tag.group(1) if tag else ""
        classes = re.findall(r"\.([A-Za-z0-9_-]+)", sel)
        if tag and props:
            rules.append({"tag": tag, "classes": set(classes), "props": props, "score": len(sel)})
    rules.sort(key=lambda r: r["score"])

    def apply(m: re.Match) -> str:
        el = m.group(0)
        tag_m = re.match(r"<([a-zA-Z]+)", el)
        tag = tag_m.group(1) if tag_m else ""
        own = re.search(r'class="([^"]+)"', el)
        classes = set((own.group(1) if own else "").split())
        # ancestor classes are inherited via the enclosing <g> chain; to keep it
        # cheap, walk the whole string backwards for the nearest <g> class only.
        before = svg[: m.start()]
        for g in reversed(list(re.finditer(r'<g[^>]*class="([^"]+)"', before))):
            classes |= set(g.group(1).split())
            if "node" in classes or len(classes) > 4:
                break
        fill = stroke = sw = None
        for r in rules:
            if r["tag"] == tag and r["classes"] <= classes:
                fill = r["props"].get("fill", fill)
                stroke = r["props"].get("stroke", stroke)
                sw = r["props"].get("stroke-width", sw)
        out = el
        if tag == "text":
            if "font-size" not in out:
                out = out.replace("<text", f'<text font-size="{font_size:.0f}"', 1)
            if "font-family" not in out:
                out = out.replace("<text", '<text font-family="Microsoft YaHei, sans-serif"', 1)
            if fill and 'fill="' not in out and "fill:" not in out:
                out = out.replace("<text", f'<text fill="{fill}"', 1)
        elif fill and 'fill="' not in out and "fill:" not in out:
            out = out.replace(f"<{tag}", f'<{tag} fill="{fill}"', 1)
        if stroke and 'stroke="' not in out:
            out = out.replace(f"<{tag}", f'<{tag} stroke="{stroke}"', 1)
        if sw and 'stroke-width="' not in out and tag not in ("text", "tspan"):
            out = out.replace(f"<{tag}", f'<{tag} stroke-width="{sw}"', 1)
        return out

    svg = re.sub(r"<(path|rect|circle|polygon|line|text)\b[^>]*>", apply, svg)
    return svg


def _flatten_text(svg: str, font_size: float) -> str:
    def fix(m: re.Match) -> str:
        block = m.group(0)
        if not _EMY.search(block):
            return block
        ty = re.search(r"y=\"(-?[\d.]+)\"", block)
        base = float(ty.group(1)) if ty else 0.0
        lines = [t for t in re.findall(r"<tspan[^>]*>([^<]*)</tspan>", block) if t.strip()]
        if not lines:
            return block
        anchor = "middle"
        am = re.search(r"text-anchor=\"(middle|start|end)\"", block)
        if am:
            anchor = am.group(1)
        fill = re.search(r'fill="([^"]+)"', block)
        parts = []
        for i, line in enumerate(lines):
            y = base + font_size * (1.0 + 1.1 * i)
            attrs = f'x="0" y="{y:.1f}" text-anchor="{anchor}"'
            if fill:
                attrs += f' fill="{fill.group(1)}"'
            parts.append(f"<text {attrs}>{line}</text>")
        return "".join(parts)

    return _TEXT.sub(fix, svg)


def fit_size(text: str, width_in: float, height_in: float, start: int, minimum: int = 12) -> int:
    size = start
    while size > minimum:
        cpl = max(1, int(width_in * 72 / size))
        lines = 0
        for para in text.split("\n"):
            lines += max(1, -(-len(para) // cpl))
        if lines * size * 1.35 / 72 <= height_in:
            break
        size -= 1
    return size


def textbox(slide, l, t, w, h, text, size=18, bold=False, color=DARK, align=PP_ALIGN.LEFT,
            anchor=MSO_ANCHOR.TOP, spacing=1.15):
    box = slide.shapes.add_textbox(Inches(l), Inches(t), Inches(w), Inches(h))
    tf = box.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Inches(0.02)
    tf.margin_top = tf.margin_bottom = Inches(0.01)
    size = fit_size(text, w, h, size)
    for i, para in enumerate(text.split("\n")):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = spacing
        run = p.add_run()
        run.text = para
        run.font.name = FONT
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = color
    return box


def add_bullets(slide, l, t, w, h, items, size=18):
    text = "\n".join(f"- {x}" for x in items)
    return textbox(slide, l, t, w, h, text, size=size)


def add_picture(slide, path: Path, box, name=None):
    l, t, w, h = box
    pic = slide.shapes.add_picture(str(path), Inches(l), Inches(t), Inches(w), Inches(h))
    if name:
        pic.name = name
    return pic


def contain(path: Path, box) -> tuple[float, float, float, float]:
    from PIL import Image

    l, t, w, h = box
    try:
        with Image.open(path) as im:
            iw, ih = im.size
    except Exception:
        return box
    scale = min(w / iw, h / ih)
    nw, nh = iw * scale, ih * scale
    return (l + (w - nw) / 2, t + (h - nh) / 2, nw, nh)


def footer(slide, text):
    textbox(slide, MARGIN, H - 0.5, W - 2 * MARGIN, 0.3, text, size=10, color=MUTED)


def header(slide, headline, kicker=""):
    if kicker:
        textbox(slide, MARGIN, 0.32, W - 2 * MARGIN, 0.3, kicker, size=12, color=ACCENT, bold=True)
    textbox(slide, MARGIN, 0.62, W - 2 * MARGIN, 1.0, headline, size=30, bold=True)


def _layout(prs, key):
    """Find a slide layout by name substring (e.g. '正文页-标题及内容'). Fallback to first."""
    for l in prs.slide_layouts:
        if key in l.name:
            return l
    return prs.slide_layouts[0]


def fill_title(slide, text):
    """Fill the layout's title placeholder (user-prebuilt) with text only —
    no font/formatting, the master placeholder auto-formats it."""
    for sh in slide.shapes:
        if sh.is_placeholder and sh.placeholder_format.type in (PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE):
            sh.text_frame.text = text
            return
    textbox(slide, MARGIN, 0.62, W - 2 * MARGIN, 1.0, text, size=28, bold=True, color=DARK)


def fill_ph(slide, ph_type, text):
    """Fill a placeholder by type (TITLE/CENTER_TITLE/SUBTITLE/BODY...) with text only."""
    for sh in slide.shapes:
        if sh.is_placeholder and sh.placeholder_format.type == ph_type:
            sh.text_frame.text = text
            return True
    return False


def slide_cover(prs, s, meta):
    sl = prs.slides.add_slide(_layout(prs, "封面页"))
    # 中部 = 标题；上部 = 原英文标题；下部 = 组会文献分享：作者-期刊简写-发表时间
    fill_ph(sl, PP_PLACEHOLDER.CENTER_TITLE, s["headline"])
    title = meta.get("title") or meta.get("short_title") or ""
    if title:
        fill_ph(sl, PP_PLACEHOLDER.SUBTITLE, title)
    authors = meta.get("authors", "")
    jshort = meta.get("journal_short") or meta.get("journal", "")
    sig = f"组会文献分享：{authors}-{jshort}-{meta.get('year', '')}"
    fill_ph(sl, PP_PLACEHOLDER.BODY, sig)


def slide_text(prs, s, footer_text):
    sl = prs.slides.add_slide(_layout(prs, "正文页-标题及内容"))
    fill_title(sl, s["headline"])
    add_bullets(sl, MARGIN, 1.7, W - 2 * MARGIN, 4.8, s.get("bullets", []), size=20)
    footer(sl, footer_text)


def slide_image(prs, s, base, footer_text, plans, svg_backend):
    sl = prs.slides.add_slide(_layout(prs, "正文页-标题及内容"))
    fill_title(sl, s["headline"])
    src = s.get("image") or (s.get("figure") or {}).get("path")
    caption = (s.get("figure") or {}).get("caption") or ""
    box = (MARGIN, 1.7, W - 2 * MARGIN, 4.6 if caption else 5.0)
    if not src:
        textbox(sl, MARGIN, 2.2, W - 2 * MARGIN, 1, "[缺图：deck.json 未给 image]", size=18, color=WARN)
    else:
        path = (base / src).resolve()
        # 图片一律用 PNG（svg 直接取同名 png，不做 com 降级/不写 svgplan）
        if path.suffix.lower() == ".svg":
            png = path.with_suffix(".png")
            path = png if png.exists() else path
        if path.exists():
            add_picture(sl, path, contain(path, box))
        else:
            textbox(sl, MARGIN, 2.2, W - 2 * MARGIN, 1, f"[缺图] {src}", size=16, color=WARN)
    if caption:
        textbox(sl, MARGIN, 6.45, W - 2 * MARGIN, 0.5, caption, size=12, color=MUTED)
    footer(sl, footer_text)


def slide_annotation(prs, s, base, ann, footer_text):
    sl = prs.slides.add_slide(_layout(prs, "正文页-标题及内容"))
    fill_title(sl, s["headline"])
    record = (ann or {}).get("items", [])
    rec = next((x for x in record if x["key"] == s.get("annotation")), None)
    crop = None
    if rec and rec.get("crop"):
        crop = (base / rec["crop"]).resolve()
        if not crop.exists():
            crop = None
    left_w = 5.7
    if crop:
        add_picture(sl, crop, contain(crop, (MARGIN, 1.75, left_w, 4.55)))
        frame = sl.shapes.add_shape(1, Inches(MARGIN), Inches(1.75), Inches(left_w), Inches(4.55))
        frame.fill.background()
        frame.line.color.rgb = RGBColor(0xD1, 0x4B, 0x3A)
        frame.line.width = Pt(1.5)
        textbox(sl, MARGIN, 6.35, left_w, 0.35,
                f"p.{rec.get('page_label') or rec.get('page_index')} · {rec.get('color_category') or ''}", size=11, color=MUTED)
        rx = MARGIN + left_w + 0.45
        rw = W - rx - MARGIN
        qy, qh = 1.75, 1.55
        cy, ch = 3.45, 1.0
        ry, rh = 4.65, 1.6
    else:
        rx = MARGIN
        rw = W - 2 * MARGIN
        qy, qh = 1.75, 1.9
        cy, ch = 3.85, 1.0
        ry, rh = 5.05, 1.5
    quote = s.get("quote") or (rec or {}).get("text", "")
    if quote:
        textbox(sl, rx, qy, rw, qh, f"“{quote}”", size=15, color=DARK)
    comment = s.get("comment") or (rec or {}).get("comment", "")
    box = sl.shapes.add_shape(1, Inches(rx), Inches(cy), Inches(rw), Inches(ch))
    box.fill.solid()
    box.fill.fore_color.rgb = LIGHT
    box.line.fill.background()
    textbox(sl, rx + 0.15, cy + 0.1, rw - 0.3, ch - 0.2,
            ("我的批注：" + comment) if comment else "（无文字批注，仅高亮）", size=13, color=ACCENT)
    if s.get("reading"):
        textbox(sl, rx, ry, rw, rh, "解读：" + s["reading"], size=13, color=MUTED)
    footer(sl, footer_text)


def _strip_footer_phs(slide) -> None:
    """Remove footer/date/slide-number placeholder shapes when using a template
    (deck draws its own footer with citekey · title · page)."""
    for ph in list(slide.placeholders):
        idx = ph.placeholder_format.idx
        if idx in (13, 15, 16):  # SLIDE_NUMBER, FOOTER, DATE
            sp = ph._element
            sp.getparent().remove(sp)


def slide_section(prs, s, footer_text):
    """章节页（版式2 节标题）：标题 + 副标题 + 节编号。"""
    sl = prs.slides.add_slide(_layout(prs, "节标题"))
    fill_title(sl, s["headline"])
    if s.get("subtitle"):
        fill_ph(sl, PP_PLACEHOLDER.SUBTITLE, s["subtitle"])
    footer(sl, footer_text)


def slide_final(prs, s, footer_text):
    """末尾页：下方谢谢，上方文本框由 LLM 填汇报总结（名称/关键词/关键结论）。"""
    sl = prs.slides.add_slide(_layout(prs, "末尾页"))
    fill_title(sl, "谢谢！")  # 下方标题占位符 = 谢谢
    summary = s.get("summary") or {}
    lines = []
    if summary.get("title"):
        lines.append(f"汇报名称：{summary['title']}")
    if summary.get("keywords"):
        lines.append("关键词：" + "、".join(summary["keywords"]))
    if summary.get("conclusion"):
        lines.append(f"关键结论：{summary['conclusion']}")
    if lines:
        fill_ph(sl, PP_PLACEHOLDER.SUBTITLE, "汇报总结：\n" + "\n".join(lines))
    footer(sl, footer_text)


def build(deck: dict, base: Path, out: Path, svg_backend: str, ann: dict | None, template: str | None = None) -> list[dict]:
    prs = Presentation(template) if template else Presentation()
    prs.slide_width = Inches(W)
    prs.slide_height = Inches(H)
    meta = deck.get("meta", {})
    citekey = meta.get("citekey", "")
    plans: list[dict] = []

    for idx, s in enumerate(deck.get("slides", []), 1):
        footer_text = " · ".join(x for x in [citekey, meta.get("title", "")[:28], f"{idx}/{len(deck['slides'])}"] if x)
        t = s.get("type")
        if t == "cover":
            slide_cover(prs, s, meta)
        elif t == "section":
            slide_section(prs, s, footer_text)
        elif t == "final":
            slide_final(prs, s, footer_text)
        elif t == "annotation":
            slide_annotation(prs, s, base, ann, footer_text)
        elif t in ("figure", "map", "outline", "table"):
            slide_image(prs, s, base, footer_text, plans, svg_backend)
        else:
            slide_text(prs, s, footer_text)
        if template:
            _strip_footer_phs(prs.slides[-1])
        notes = s.get("notes")
        if notes:
            # ② 出处/图源进备注，不上正文（社区共识：观众读页面，讲者读备注）
            prov = []
            src = s.get("image") or (s.get("figure") or {}).get("path")
            if src:
                prov.append(f"图源：{src}")
            if s.get("annotation"):
                prov.append(f"批注：{s['annotation']}")
            if prov:
                notes = notes.rstrip() + "\n\n[来源] " + " · ".join(prov)
            prs.slides[-1].notes_slide.notes_text_frame.text = notes

    out.parent.mkdir(parents=True, exist_ok=True)
    prs.save(out)
    return plans


def insert_svgs_com(pptx: Path, plans: list[dict]) -> bool:
    if not plans:
        return True
    try:
        import win32com.client as win32
    except ImportError:
        print("win32com not available; keep PNG preview", file=sys.stderr)
        return False
    app = None
    tmpdir = None
    try:
        import tempfile
        tmpdir = Path(tempfile.mkdtemp(prefix="kmap-svg-"))
        app = win32.DispatchEx("PowerPoint.Application")
        pres = app.Presentations.Open(str(pptx), WithWindow=False)
        for p in plans:
            src = Path(p["file"])
            sl = pres.Slides(p["slide"])
            try:
                sl.Shapes(p["slot"]).Delete()
            except Exception:
                pass
            if src.name.startswith("mindmap"):
                # PowerPoint's SVG engine drops text on mermaid mindmap nodes
                # (white-on-dark nodes come out blank). The radial map is the one
                # figure we ship as a crisp PNG; the editable SVG is still in maps/.
                png = src.with_suffix(".png")
                if png.exists():
                    sl.Shapes.AddPicture(str(png), False, True, p["left"], p["top"], p["width"], p["height"])
                    p["degraded_to_png"] = "PowerPoint cannot render mindmap SVG text reliably"
                    continue
            safe = tmpdir / (src.stem + ".svg")
            safe.write_text(pptx_safe_svg(src.read_text(encoding="utf-8")), encoding="utf-8")
            sl.Shapes.AddPicture(str(safe), False, True, p["left"], p["top"], p["width"], p["height"])
        pres.Save()
        pres.Close()
        return True
    except Exception as exc:  # pragma: no cover - depends on Office
        print(f"COM SVG insert failed: {exc}", file=sys.stderr)
        return False
    finally:
        if app is not None:
            try:
                app.Quit()
            except Exception:
                pass


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser()
    ap.add_argument("--deck", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--svg-backend", choices=["com", "png"], default="png")
    ap.add_argument("--annotations", default="annotations.json")
    ap.add_argument("--mark-rect", action="store_true")
    ap.add_argument("--template", default=None, help="PPTX 母版模板路径（默认自动找技能 templates/deck-template.pptx）")
    args = ap.parse_args()

    deck_path = Path(args.deck).resolve()
    base = deck_path.parent.parent
    deck = json.loads(deck_path.read_text(encoding="utf-8"))
    ann_path = base / args.annotations
    ann = json.loads(ann_path.read_text(encoding="utf-8")) if ann_path.exists() else None

    out = Path(args.out).resolve()
    template = args.template
    if not template:
        # 项目级模板优先（<proj>/deck/template.pptx），否则技能默认
        proj_tpl = out.parent / "template.pptx"
        if proj_tpl.exists():
            template = str(proj_tpl)
        else:
            _cand = Path(__file__).resolve().parent.parent / "templates" / "deck-template.pptx"
            if _cand.exists():
                template = str(_cand)
    plans = build(deck, base, out, args.svg_backend, ann, template)

    print(json.dumps({
        "ok": True, "pptx": str(out), "slides": len(deck.get("slides", [])),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
