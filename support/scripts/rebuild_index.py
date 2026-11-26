#!/usr/bin/env python3
"""
Rock Index Rebuild — 检查并刷新 RAG / research.db 索引状态。

单项目：所有路径相对项目根（ROCK_PROJECT_ROOT || cwd）。
  - research.db  →  <项目根>/data/research.db
  - rag.db      →  向上查找 .pi/rag/rag.db（由 scripts/rag-rebuild/rag_rebuild.mjs 生成，非 pi-local-rag 产物），回落 ~/.pi/rag/rag.db
  - 论文目录     →  <项目根>/paper-raw/（递归扫 PDF）

Usage:
    python3 rebuild_index.py                  # 报告当前项目索引状态
    python3 rebuild_index.py --full           # 同上（占位；全量重建用 scripts/rag-rebuild/rag_rebuild.mjs）
"""
import argparse
import sqlite3
from pathlib import Path


def project_root() -> Path:
    """项目根 = ROCK_PROJECT_ROOT || cwd。"""
    import os
    return Path(os.environ.get("ROCK_PROJECT_ROOT") or os.getcwd()).resolve()


def find_rag_db(root: Path) -> Path | None:
    """项目级 RAG 索引库：向上查找 .pi/rag/rag.db（由 rag_rebuild.mjs 生成），不越过 $HOME，回落 ~/.pi/rag/rag.db。"""
    # 向上走找 .pi/rag/rag.db（不越过 $HOME）
    cur = root
    home = Path.home()
    while True:
        cand = cur / ".pi" / "rag" / "rag.db"
        if cand.exists():
            return cand
        if cur == home or cur.parent == cur:
            break
        cur = cur.parent
    # 回落全局
    glob = home / ".pi" / "rag" / "rag.db"
    return glob if glob.exists() else None


def get_research_db(root: Path) -> Path | None:
    p = root / "data" / "research.db"
    return p if p.exists() else None


def report(root: Path):
    print(f"项目根: {root}")
    print("=" * 60)

    # 1. RAG store
    rag_path = find_rag_db(root)
    if rag_path:
        scope = "项目级" if root in rag_path.parents or ".pi/rag" in str(rag_path) and root in rag_path.parents else "全局回落"
        try:
            conn = sqlite3.connect(str(rag_path))
            conn.execute("PRAGMA busy_timeout=5000")  # 防 pi/WAL 写锁导致 "database is locked"
            conn.row_factory = sqlite3.Row
            cnt = conn.execute("SELECT COUNT(*) AS c FROM chunks").fetchone()["c"]
            print(f"[RAG] {rag_path}  ({scope})")
            print(f"      chunks: {cnt}")
            conn.close()
        except Exception as e:
            print(f"[RAG] {rag_path}  读取失败: {e}（数据库被占用，稍后重试；或确认 pi 未在写）")
    else:
        print(f"[RAG] 未找到 {rag_path}。重建：node --experimental-strip-types --no-warnings ~/.pi/agent/packages/rock-research-agent/support/scripts/rag-rebuild/rag_rebuild.mjs --clean（在项目根运行）")

    # 2. research.db
    res_path = get_research_db(root)
    if res_path:
        try:
            conn = sqlite3.connect(str(res_path))
            conn.row_factory = sqlite3.Row
            tables = [r["name"] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
            print(f"\n[research.db] {res_path}")
            for t in tables:
                cnt = conn.execute(f"SELECT COUNT(*) AS c FROM '{t}'").fetchone()["c"]
                print(f"   {t}: {cnt}")
            conn.close()
        except Exception as e:
            print(f"\n[research.db] {res_path}  读取失败: {e}")
    else:
        print(f"\n[research.db] 未找到（{root}/data/research.db）。首次调用任意 research 工具即惰性创建。")

    # 3. 论文目录
    papers = root / "paper-raw"
    total = 0
    if papers.exists():
        pdfs = list(papers.rglob("*.pdf"))
        total = len(pdfs)
        print(f"\n[papers] {papers}")
        print(f"   PDF 总数: {total}")
    else:
        print(f"\n[papers] 目录不存在：{papers}")
    print("=" * 60)


def main():
    ap = argparse.ArgumentParser(description="Rock 索引状态报告（项目级）")
    ap.add_argument("--full", action="store_true", help="（本脚本只报告状态，不重建）全量重建请运行：node ~/.pi/agent/packages/rock-research-agent/support/scripts/rag-rebuild/rag_rebuild.mjs --clean")
    args = ap.parse_args()
    if args.full:
        print("--full 不执行重建（本脚本只报告状态）。全量重建请运行：")
        print("  node --experimental-strip-types --no-warnings ~/.pi/agent/packages/rock-research-agent/support/scripts/rag-rebuild/rag_rebuild.mjs --clean")
        return
    report(project_root())


if __name__ == "__main__":
    main()
