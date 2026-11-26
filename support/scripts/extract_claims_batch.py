#!/usr/bin/env python3
"""
Rock Claim 抽取批处理（项目级常驻脚本）

设计要点：
  1. 强制 IPv4 解析：token.sensenova.cn 的 AAAA 记录无路由，IPv6 尝试会以 Errno 101 失败
  2. PDF 类型在运行时按"清洗后字符密度+乱码率"实时判定，不信任 JSON 缓存的 text_quality 字段（中文正文易被字符密度规则误判成扫描件）
  3. 送 LLM 前清洗控制字符（\x04 等 PyMuPDF 字体映射垃圾），避免 JSON 解析失败
  4. 单篇失败计数持久化：连续失败 2 轮跳过并记录，不阻塞队列
  5. 日志只写一份（文件句柄由 nohup 重定向提供）

Usage:
    nohup python3 extract_claims_batch.py <project_root> [--project-id N] >> <log> 2>&1 &
"""
import argparse
import json
import re
import signal
import socket
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_claims_llm as ecll

# ── 强制 IPv4：该 API 的 AAAA 无全局路由，IPv6 连接必报 Errno 101 ──
_orig_getaddrinfo = socket.getaddrinfo

def ipv4_only_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)

socket.getaddrinfo = ipv4_only_getaddrinfo

CTRL_RE = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')

running = True
signal.signal(signal.SIGINT, lambda s, f: globals().__setitem__('running', False))


def clean_text(t: str) -> str:
    return CTRL_RE.sub(' ', t or '')


def screen_pdf(doc: dict) -> tuple[str, float]:
    """运行时判类型：text | scanned。以清洗后文本实时判定，不信任 JSON 缓存的 text_quality 字段。"""
    pages = doc.get('pages') or []
    if not pages:
        return 'unknown', 0.0
    texts = [clean_text(p.get('text', '')) for p in pages]
    total = sum(len(t) for t in texts)
    avg = total / len(pages)
    joined = '\n'.join(texts)
    ctrl = sum(1 for c in joined if ord(c) < 32 and c not in '\n\r\t')
    garbage_ratio = (ctrl / len(joined)) if joined else 1.0
    if garbage_ratio > 0.2 or avg < 300:   # 真扫描件/严重乱码
        return 'scanned', garbage_ratio
    return 'text', avg


def load_state(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except Exception:
            pass
    return {"failed": {}, "done": []}


class Runner:
    def __init__(self, root: Path, pid: int | None):
        self.root = root
        self.db_path = root / 'data/research.db'
        self.state_path = root / 'data/extract_batch_state.json'
        self.log_path = root / 'logs/claims_batch.log'
        self.state = load_state(self.state_path)
        self.key, self.base, used_var = ecll.load_sensenova_creds()
        self.model = ecll.DEFAULT_MODEL  # 跟随 extract_claims_llm 的默认模型（sensenova-6.8-flash-lite）
        self.project_name = None
        if pid is None:
            conn = self.connect_db()
            row = conn.execute("SELECT id FROM projects WHERE name=?",
                               (root.name,)).fetchone()
            conn.close()
            pid = row[0] if row else ecll.ensure_project(ecll.open_db(root), root.name)
        self.pid = pid
        # 目标：运行时筛查出的文字版论文
        papers = sorted((root / 'paper-raw').glob('*.json'))
        self.text_papers = []
        for jf in papers:
            if jf.stem in [Path(p).stem for p in self.state['done']]:
                continue
            try:
                doc = json.loads(jf.read_text(encoding='utf-8'))
            except Exception:
                continue
            ptype, metric = screen_pdf(doc)
            if ptype == 'text':
                self.text_papers.append(jf)
        if not papers:
            import sys as _sys
            _sys.stderr.write(
                f"[claims-batch] paper-raw/ 下无解析 JSON（{root}/paper-raw/）。"
                f"先入库：python3 ~/.pi/agent/packages/rock-research-agent/support/scripts/ingest_pdf.py --batch <pdf目录> "
                f"--output {root}/paper-raw/\n"
            )

    def log(self, msg: str):
        line = f"[{time.strftime('%m-%d %H:%M:%S')}] {msg}\n"
        with open(self.log_path, 'a', encoding='utf-8') as f:
            f.write(line)

    def connect_db(self):
        """WAL + busy_timeout：避免其他进程（如 pi）短暂持锁时报 locked。"""
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('PRAGMA busy_timeout=30000')
        except Exception:
            pass
        return conn

    def get_claimed(self) -> set:
        db = self.connect_db()
        cur = db.execute(
            'SELECT DISTINCT e.file_path FROM evidence e '
            'JOIN claims c ON e.claim_id=c.id WHERE c.project_id=?', (self.pid,))
        claimed = {Path(r[0]).name for r in cur}
        db.close()
        return claimed

    def save_state(self):
        self.state_path.write_text(
            json.dumps(self.state, ensure_ascii=False, indent=1), encoding='utf-8')

    def clean_copy(self, jf: Path) -> Path:
        """生成清洗了控制字符的 JSON 副本（ingest_paper 从文件重读，必须落盘）。"""
        cdir = self.root / 'data' / '.cleaned'
        cdir.mkdir(parents=True, exist_ok=True)
        out = cdir / jf.name
        if out.exists() and out.stat().st_mtime >= jf.stat().st_mtime:
            return out
        try:
            doc = json.loads(jf.read_text(encoding='utf-8'))
        except Exception:
            return jf
        doc['abstract'] = clean_text(doc.get('abstract', ''))
        for p in doc.get('pages') or []:
            p['text'] = clean_text(p.get('text', ''))
        out.write_text(json.dumps(doc, ensure_ascii=False), encoding='utf-8')
        return out

    def process_paper(self, jf: Path):
        jf_c = self.clean_copy(jf)
        doc0 = json.loads(jf_c.read_text(encoding='utf-8'))
        abstract = doc0.get('abstract') or (doc0.get('pages') or [{}])[0].get('text', '')[:500]

        n = 0
        if abstract and len(abstract) > 100:
            try:
                claims = ecll.call_sensenova(
                    self.key, self.base, self.model,
                    '论文标题: ' + (doc0.get('title') or jf.stem) +
                    '\n章节: Abstract\n页码: 1\n\n正文:\n' + abstract[:3000],
                    timeout=45)
                db = self.connect_db()
                try:
                    n += sum(1 for c in claims
                             if ecll.write_claim(db, self.pid, c, str(jf), 'Abstract', 1))
                    db.commit()
                finally:
                    db.close()
            except Exception as e:
                self.log(f'  abstract err: {str(e)[:160]}')

        db = self.connect_db()
        try:
            n += ecll.ingest_paper(db, jf_c, self.pid, self.key, self.base,
                                   self.model, True)
            db.commit()
        finally:
            db.close()
        return n

    def run_forever(self):
        import sys
        # stdout 提示：self.log 只写文件，前台运行时 Bash 结果会全空、LLM 以为卡死
        if sys.stdin.isatty():
            print('[claims-batch] ⚠ 前台运行会阻塞数小时（逐篇 LLM 抽取 + 20s 间隔）。'
                  '建议：nohup python3 .../extract_claims_batch.py <root> --project-id N '
                  '>> logs/claims_batch.log 2>&1 &；进度见 logs/claims_batch.log', flush=True)
        self.log(f'Start pid={self.pid} project={self.root.name} '
                 f'text_papers={len(self.text_papers)}')
        print(f'[claims-batch] start pid={self.pid} project={self.root.name} '
              f'text_papers={len(self.text_papers)} log={self.log_path}', flush=True)
        session_attempted: set[str] = set()   # 本会话内已处理过：防止 DB 去重失效时同一篇反复重抽
        while running:
            claimed = self.get_claimed()
            failed_skip = {k for k, v in self.state['failed'].items() if v >= 2}
            todo = [jf for jf in self.text_papers
                    if jf.name not in claimed and jf.stem not in failed_skip
                    and jf.name not in session_attempted]
            if not todo:
                self.log(f'ALL DONE (claimed={len(claimed)}, skipped={len(failed_skip)})')
                print(f'[claims-batch] ALL DONE (claimed={len(claimed)}, '
                      f'skipped={len(failed_skip)})', flush=True)
                break
            jf = todo[0]
            nfail = self.state['failed'].get(jf.stem, 0)
            tag = f'(retry {nfail})' if nfail else ''
            self.log(f'> {jf.name[:60]} {tag}')
            t0 = time.time()
            ok = False
            try:
                n = self.process_paper(jf)
                db = self.connect_db()
                total = db.execute('SELECT COUNT(*) FROM claims WHERE project_id=?',
                                   (self.pid,)).fetchone()[0]
                remain = len(todo) - 1
                db.close()
                self.log(f'  +{n} claims total:{total} remain:{remain} '
                         f'({time.time()-t0:.0f}s)')
                ok = n > 0
            except Exception as e:
                msg = str(e)
                self.log(f'  ERROR: {type(e).__name__}: {msg[:200]}')
                if 'locked' in msg.lower():
                    # 数据库锁是环境问题不是论文问题：退避重试，不计失败
                    self.log('  db locked, 退避 60s 后重试本篇')
                    time.sleep(60)
                    continue
            if ok:
                self.state['failed'].pop(jf.stem, None)
                self.state['done'].append(str(jf))
                # 失败不加入：留给下一轮重试（最多 2 轮后进 state 跳过名单）
                session_attempted.add(jf.name)
            else:
                self.state['failed'][jf.stem] = nfail + 1
                if self.state['failed'][jf.stem] >= 2:
                    self.log(f'  SKIP {jf.stem}: 连续失败 2 轮')
                    time.sleep(30)   # 连续失败多半是网络/限流，退避一下
            self.save_state()
            if running:
                time.sleep(20)
        self.log('Stopped')
        print('[claims-batch] Stopped', flush=True)


def main():
    ap = argparse.ArgumentParser(description='Rock claim 抽取批处理（项目级常驻）')
    ap.add_argument('root', help='项目根目录（含 paper-raw/ 与 data/）')
    ap.add_argument('--project-id', type=int, default=None)
    args = ap.parse_args()
    root = Path(args.root).resolve()
    r = Runner(root, args.project_id)
    r.run_forever()


if __name__ == '__main__':
    main()
