"""
Rock Database Backup Script（项目级）

备份当前项目的项目库（research.db）到 data/backups/。
项目根 = ROCK_PROJECT_ROOT 环境变量（未设则当前工作目录）。
注：RAG 索引 .pi/rag/rag.db 体积大（数百 MB），默认不备份，可用 rag-rebuild 重建。

Usage:
    python3 backup.py                          # 默认输出 <项目>/data/backups/
    python3 backup.py --output /path/to/dir
"""
import argparse
import datetime
import os
import shutil
from pathlib import Path


def project_root() -> Path:
    return Path(os.environ.get("ROCK_PROJECT_ROOT") or os.getcwd()).resolve()


# 项目库按项目一套，落盘在项目 data/ 下（无 papers.db，RAG 索引在 .pi/rag/rag.db 不在此列）
BACKUP_SOURCES = [
    ("research.db", "data/research.db"),
]


def backup(output_dir: Path):
    root = project_root()
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_dir = output_dir / f"rock_backup_{timestamp}"
    backup_dir.mkdir(parents=True, exist_ok=True)

    for name, rel in BACKUP_SOURCES:
        src = root / rel
        if src.exists():
            dst = backup_dir / name
            shutil.copy2(str(src), str(dst))
            size = src.stat().st_size
            print(f"  {name}: {size:,} bytes → {dst}")
        else:
            print(f"  {name}: not found, skipped")

    print(f"\nBackup saved to: {backup_dir}")


def main():
    root = project_root()
    parser = argparse.ArgumentParser(description="Rock Database Backup（项目级）")
    parser.add_argument("--output", "-o",
                        default=str(root / "data" / "backups"),
                        help="Backup output directory (default: <项目>/data/backups)")
    args = parser.parse_args()
    backup(Path(args.output))


if __name__ == "__main__":
    main()
