#!/usr/bin/env python3
"""
Rock PDF Ingestion Pipeline

Process: detect → hash → PyMuPDF extract → quality check → PaddleOCR GPU (low-quality pages) → normalized JSON → RAG indexing (rag_rebuild.mjs)

Usage:
    python3 ingest_pdf.py <pdf_path> [--output <dir>] [--force]
    python3 ingest_pdf.py --batch <dir> [--output <dir>] [--force]
"""

import argparse
import json
import hashlib
import os
import sys
from pathlib import Path
from typing import Optional

from parse_pdf import parse_pdf, ParsedDocument


def file_hash(path: Path) -> str:
    """SHA256 hash of file contents."""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def output_path(pdf_path: Path, output_dir: Path) -> Path:
    """Generate normalized JSON output path."""
    stem = pdf_path.stem
    return output_dir / f"{stem}.json"


def already_indexed(pdf_path: Path, output_dir: Path) -> bool:
    """Check if this PDF was already ingested."""
    out = output_path(pdf_path, output_dir)
    if not out.exists():
        return False
    try:
        with open(out, encoding='utf-8') as f:
            meta = json.load(f)
        return meta.get('file_hash') == file_hash(pdf_path)
    except (json.JSONDecodeError, KeyError, UnicodeDecodeError):
        return False


def ingest_single(pdf_path: Path, output_dir: Path, force: bool = False) -> Optional[ParsedDocument]:
    """Ingest a single PDF: parse + save normalized JSON."""
    if not force and already_indexed(pdf_path, output_dir):
        print(f"  SKIP {pdf_path.name} (already indexed)")
        return None

    print(f"  PARSING {pdf_path.name}...")
    try:
        doc = parse_pdf(str(pdf_path), output_dir=str(output_dir))
        return doc
    except Exception as e:
        print(f"  ERROR {pdf_path.name}: {e}", file=sys.stderr)
        return None


def ingest_batch(pdf_dir: Path, output_dir: Path, force: bool = False) -> list[ParsedDocument]:
    """Ingest all PDFs in a directory."""
    pdfs = sorted(pdf_dir.glob("*.pdf"))
    print(f"Found {len(pdfs)} PDF(s) in {pdf_dir}")
    results = []
    for pdf in pdfs:
        doc = ingest_single(pdf, output_dir, force)
        if doc:
            results.append(doc)
    print(f"Ingested {len(results)}/{len(pdfs)} PDFs")
    return results


def main():
    parser = argparse.ArgumentParser(description="Rock PDF Ingestion Pipeline")
    parser.add_argument("input", help="PDF file or directory (with --batch)")
    parser.add_argument("--output", "-o", default=None,
                        help="Output directory (default: <项目根>/paper-raw/)")
    parser.add_argument("--force", "-f", action="store_true",
                        help="Re-parse even if already indexed")
    parser.add_argument("--batch", "-b", action="store_true",
                        help="Process all PDFs in a directory")

    args = parser.parse_args()
    input_path = Path(args.input).resolve()

    if args.batch:
        if not input_path.is_dir():
            print(f"Error: --batch requires a directory, got {input_path}", file=sys.stderr)
            sys.exit(1)
        output_dir = Path(args.output) if args.output else (Path(os.environ.get("ROCK_PROJECT_ROOT") or os.getcwd()) / "paper-raw")
        output_dir.mkdir(parents=True, exist_ok=True)
        ingest_batch(input_path, output_dir, force=args.force)
    else:
        if not input_path.is_file() or input_path.suffix.lower() != '.pdf':
            print(f"Error: input must be a PDF file", file=sys.stderr)
            sys.exit(1)
        output_dir = Path(args.output) if args.output else (Path(os.environ.get("ROCK_PROJECT_ROOT") or os.getcwd()) / "paper-raw")
        output_dir.mkdir(parents=True, exist_ok=True)
        ingest_single(input_path, output_dir, force=args.force)


if __name__ == "__main__":
    main()
