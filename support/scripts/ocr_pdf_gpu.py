#!/usr/bin/env python3
"""
Rock OCR（GPU 版）：PaddleOCR 3.7 + paddlepaddle-gpu 3.3.1 cu130。

运行环境：具备 PaddleOCR + paddlepaddle-gpu（CUDA）的 Python 环境，**动态选择，不写死 conda/uv/具体环境名**（见 AGENTS.md「OCR 环境」）。
性能：~2.5s/页（200dpi），峰值 RSS 2.5GB，连续多页稳定。

由 parse_pdf.py 调用（GPU 是唯一 OCR 路径，环境缺失直接报错并给出重建命令）。
输出 ParsedDocument JSON，schema 与 parse_pdf.py 的 PyMuPDF 路径一致。

Usage: python ocr_pdf_gpu.py <pdf> <out_json> [--lang en|ch] [--dpi N]
"""
import sys
import json
import argparse
import hashlib
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description="Rock OCR 兜底（GPU OCR 环境）")
    ap.add_argument("pdf", help="输入 PDF 路径")
    ap.add_argument("out_json", help="输出 ParsedDocument JSON 路径")
    ap.add_argument("--lang", default="en", help="OCR 语言: en|ch（默认 en）")
    ap.add_argument("--dpi", type=int, default=200, help="渲染 DPI（默认 200）")
    args = ap.parse_args()

    import pymupdf
    from PIL import Image
    import numpy as np
    from paddleocr import PaddleOCR

    ocr = PaddleOCR(
        device="gpu:0",
        lang=args.lang,
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,   # GPU 已知 bug：粗体文本识别损坏
    )

    doc = pymupdf.open(args.pdf)
    pages = []
    full_text = []
    for i in range(len(doc)):
        pix = doc[i].get_pixmap(dpi=args.dpi)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        result = ocr.predict(np.array(img))
        texts = result[0]["rec_texts"] or []
        text = "\n".join(texts)
        pages.append({
            "number": i + 1, "text": text,
            "has_tables": False, "has_figures": False, "reading_order": [],
        })
        full_text.append(text)
    doc.close()

    combined = "\n".join(full_text)
    pdf_path = Path(args.pdf).resolve()
    out = {
        "file_path": str(pdf_path),
        "file_hash": hashlib.sha256(pdf_path.read_bytes()).hexdigest(),
        "file_size": pdf_path.stat().st_size,
        "title": pdf_path.stem,
        "authors": "", "abstract": "",
        "year": "",
        "pages": pages,
        "sections": [],
        "references": [],
        "num_pages": len(pages),
        "extraction_method": "paddleocr",
        "text_quality": 0.7 if combined.strip() else 0.0,
    }
    Path(args.out_json).write_text(
        json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"✓ GPU OCR {len(pages)} 页，文字 {len(combined)} 字符 → {args.out_json}")


if __name__ == "__main__":
    main()
