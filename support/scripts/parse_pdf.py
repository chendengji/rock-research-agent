#!/usr/bin/env python3
"""
Rock PDF Parsing Layer

Strategy:
  1. PyMuPDF extract text
  2. Quality check (character density, structure)
  3. If poor/scanned → PaddleOCR PP-StructureV3 fallback
  4. Normalize to ParsedDocument JSON
"""

import json
import os
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Optional


# ---- Data Model ----

@dataclass
class ParsedSection:
    title: str
    level: int
    text: str
    page_start: int
    page_end: int


@dataclass
class ParsedReference:
    index: int
    text: str
    authors: str = ""
    title: str = ""
    year: str = ""
    journal: str = ""


@dataclass
class ParsedPage:
    number: int
    text: str
    has_tables: bool = False
    has_figures: bool = False
    reading_order: list[int] = field(default_factory=list)


@dataclass
class ParsedDocument:
    file_path: str
    file_hash: str
    file_size: int
    title: str
    authors: str
    abstract: str
    year: str
    pages: list[ParsedPage]
    sections: list[ParsedSection]
    references: list[ParsedReference]
    num_pages: int
    extraction_method: str  # 'pymupdf' | 'paddleocr'
    text_quality: float     # 0.0 - 1.0


# ---- Quality Check ----

def check_text_quality(text: str) -> float:
    """Score text quality 0.0-1.0 based on character density and structure."""
    if not text or len(text.strip()) < 100:
        return 0.0
    # Count alphanumeric vs total characters
    total = len(text)
    alpha = sum(1 for c in text if c.isalnum() or c in ' .,;:!?-')
    density = alpha / total if total > 0 else 0
    # Penalize very low density (scanned/OCR-like)
    # 注意：不用 density>0.95 判噪声——中文正文每个汉字都算 alnum，
    # 密度天然接近 1，正常中文文献会被误判成低质量
    if density < 0.3:
        return density * 0.5
    # 结构评分：段落 + 控制字符占比（真扫描件/字体乱码会有大量 \x04 等）
    paragraphs = [p for p in text.split('\n\n') if len(p.strip()) > 40]
    structure_score = min(len(paragraphs) / 10, 1.0)
    ctrl = sum(1 for c in text if ord(c) < 32 and c not in '\n\r\t')
    garbage_ratio = ctrl / total
    base = min(density * 0.6 + structure_score * 0.4, 1.0)
    # 乱码比例超过 20% 视为提取失败（触发 OCR 兜底）
    if garbage_ratio > 0.2:
        return base * 0.4
    return base


# ---- PyMuPDF Extraction ----

def extract_with_pymupdf(pdf_path: str) -> Optional[ParsedDocument]:
    """Extract text and structure using PyMuPDF."""
    try:
        import pymupdf
    except ImportError:
        print("  PyMuPDF not available, skipping", file=sys.stderr)
        return None

    doc = pymupdf.open(pdf_path)
    pages = []
    full_text = []
    sections = []
    references = []

    # First pass: extract pages
    for i in range(len(doc)):
        page = doc[i]
        text = page.get_text("text")
        pages.append(ParsedPage(
            number=i + 1,
            text=text,
            has_tables=bool(page.get_images()),
            has_figures=bool(page.get_image_info())
        ))
        full_text.append(text)

    # Quality check
    combined = '\n'.join(full_text)
    quality = check_text_quality(combined)

    if quality < 0.3:
        doc.close()
        return None  # trigger OCR fallback

    # Section detection (heuristic: large font / bold lines)
    section_patterns = [
        r'^(?:Abstract|Introduction|Background|Methodology?|Methods?|'
        r'Experimental|Results?|Discussion|Conclusion[s]?|'
        r'Acknowledgments?|References?)\s*$'
    ]
    section_re = re.compile('|'.join(section_patterns), re.IGNORECASE | re.MULTILINE)

    for i, page in enumerate(pages):
        for line in page.text.split('\n'):
            line = line.strip()
            if section_re.match(line):
                sections.append(ParsedSection(
                    title=line.capitalize(),
                    level=1,
                    text="",
                    page_start=i + 1,
                    page_end=i + 1
                ))

    # Simple reference extraction (last section lines)
    # This is basic; real extraction needs more sophistication
    ref_section_started = False
    ref_counter = 0
    for i, page in enumerate(pages):
        for line in page.text.split('\n'):
            line = line.strip()
            if re.match(r'^References?\s*$', line, re.IGNORECASE):
                ref_section_started = True
                continue
            if ref_section_started and len(line) > 40 and re.search(r'\d{4}', line):
                ref_counter += 1
                references.append(ParsedReference(index=ref_counter, text=line[:200]))

    doi_match = re.search(r'(10\.\d{4,}/[^\s,;]+)', combined)
    year_match = re.search(r'(19|20)\d{2}', combined[:2000])  # title page usually

    # Title extraction (first large-ish line on page 1)
    title = ""
    if pages:
        first_lines = [l.strip() for l in pages[0].text.split('\n') if l.strip() and len(l.strip()) > 20]
        title = first_lines[0] if first_lines else os.path.basename(pdf_path)

    # Metadata
    meta = doc.metadata or {}
    doc.close()

    # Build result
    result = ParsedDocument(
        file_path=os.path.abspath(pdf_path),
        file_hash="",  # filled by caller
        file_size=os.path.getsize(pdf_path),
        title=meta.get('title', title),
        authors=meta.get('author', ''),
        abstract="",  # would need section targeting
        year=meta.get('year', year_match.group(0) if year_match else ''),
        pages=pages,
        sections=sections,
        references=references,
        num_pages=len(pages),
        extraction_method='pymupdf',
        text_quality=quality
    )

    # Try to find abstract
    abstract_match = re.search(
        r'Abstract[:\s]*\n(.*?)(?=\n\s*(?:Introduction|Keywords?|1\.|I\.))',
        combined, re.DOTALL | re.IGNORECASE
    )
    if abstract_match:
        result.abstract = abstract_match.group(1).strip()[:1000]

    return result


# ---- PaddleOCR Fallback ----

def extract_with_paddleocr(pdf_path: str, lang: str = "ch") -> Optional[ParsedDocument]:
    """扫描件/图像型 PDF 兜底：PaddleOCR GPU（唯一 OCR 路径）。
    paddlepaddle-gpu 3.3.1 cu130 + paddleocr 3.7，~2.5s/页、RSS 2.5GB，
    见 ocr_pdf_gpu.py。GPU 环境缺失时直接报错并给出重建命令。
    lang 默认 ch（PaddleOCR 中文模型，兼识别英文）；英文纯扫描件可传 en。"""
    import subprocess
    import json
    import tempfile
    import shlex
    import shutil
    import os as _os

    # 动态选择 PaddleOCR GPU 运行器（cmd 列表），不写死环境名/路径
    # 顺序：① PADDLE_GPU_PYTHON（可带参数）→ ② uv 优先（未配置时）→ ③ 系统 python → 无
    raw = _os.environ.get("PADDLE_GPU_PYTHON", "").strip()
    if raw:
        gpu_runner = shlex.split(raw)
    elif shutil.which("uv"):
        gpu_runner = ["uv", "run", "--with", "paddleocr", "python"]
    elif shutil.which("python"):
        gpu_runner = ["python"]
    elif shutil.which("python3"):
        gpu_runner = ["python3"]
    else:
        gpu_runner = None

    if not gpu_runner:
        print("  [SKIP] OCR 环境未找到，跳过此 PDF（需要 PaddleOCR GPU）", file=sys.stderr)
        print("  建议：uv run --with paddleocr python（uv 优先）或", file=sys.stderr)
        print("        conda 环境内 pip install paddlepaddle-gpu paddleocr（环境名自定，不写死）",
              file=sys.stderr)
        return None

    ocr_script = str(Path(__file__).resolve().parent / "ocr_pdf_gpu.py")
    out_fd, out_json = tempfile.mkstemp(suffix=".json", prefix="rock_ocr_")
    _os.close(out_fd)
    try:
        proc = subprocess.run(
            gpu_runner + [ocr_script, pdf_path, out_json, "--lang", lang],
            capture_output=True, text=True, timeout=600,
        )
        if proc.returncode != 0:
            print(f"  PaddleOCR fallback 失败 (exit {proc.returncode}): {proc.stderr[-300:]}", file=sys.stderr)
            return None
        if not Path(out_json).exists() or Path(out_json).stat().st_size == 0:
            print("  PaddleOCR 产出为空", file=sys.stderr)
            return None
        data = json.loads(Path(out_json).read_text(encoding="utf-8"))
        pages = [ParsedPage(**p) for p in data.get("pages", [])]
        return ParsedDocument(
            file_path=data.get("file_path", os.path.abspath(pdf_path)),
            file_hash=data.get("file_hash", ""),
            file_size=data.get("file_size", os.path.getsize(pdf_path)),
            title=data.get("title", os.path.basename(pdf_path)),
            authors=data.get("authors", ""),
            abstract=data.get("abstract", ""),
            year=data.get("year", ""),
            pages=pages,
            sections=[],
            references=[],
            num_pages=data.get("num_pages", len(pages)),
            extraction_method="paddleocr",
            text_quality=data.get("text_quality", 0.7),
        )
    except Exception as e:
        print(f"  PaddleOCR fallback 错误: {e}", file=sys.stderr)
        return None
    finally:
        try:
            _os.unlink(out_json)
        except OSError:
            pass


# ---- Main Parse Function ----

def parse_pdf(pdf_path: str, output_dir: str | None = None) -> ParsedDocument:
    """
    Parse a PDF with tiered strategy:
      1. PyMuPDF text extraction
      2. Quality check → if poor, fallback to PaddleOCR
      3. Normalize to ParsedDocument
    """
    import hashlib

    pdf_path_obj = Path(pdf_path).resolve()
    file_hash = hashlib.sha256(pdf_path_obj.read_bytes()).hexdigest()

    # Tier 1: PyMuPDF
    doc = extract_with_pymupdf(str(pdf_path_obj))

    # Tier 2: Fallback to PaddleOCR if quality insufficient
    if doc is None or doc.text_quality < 0.3:
        print(f"  PyMuPDF quality insufficient ({doc.text_quality if doc else 0:.2f}), trying PaddleOCR...")
        doc = extract_with_paddleocr(str(pdf_path_obj))

    if doc is None:
        raise RuntimeError(f"Failed to extract text from {pdf_path} (both PyMuPDF and PaddleOCR failed)")

    # Fill hash
    doc.file_hash = file_hash

    # Save if output dir specified
    if output_dir:
        out_path = Path(output_dir) / f"{pdf_path_obj.stem}.json"
        with open(out_path, 'w', encoding='utf-8') as f:
            json.dump(asdict(doc), f, ensure_ascii=False, indent=2, default=str)
        print(f"  SAVED {out_path}")

    return doc


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <pdf_path> [output_dir]", file=sys.stderr)
        sys.exit(1)
    pdf_path = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else None
    doc = parse_pdf(pdf_path, out_dir)
    print(f"Extraction method: {doc.extraction_method}")
    print(f"Quality: {doc.text_quality:.2f}")
    print(f"Pages: {doc.num_pages}")
    print(f"Sections: {len(doc.sections)}")
    print(f"References: {len(doc.references)}")