#!/usr/bin/env python3
"""
Rock LLM 级 Claim 抽取（项目级）

用 SenseNova（商汤日日新，OpenAI 兼容）LLM 从已解析论文 JSON 抽取语义级 Claim + Evidence，
写入项目 research.db。

凭证：从 ~/.env 读取 SenseNova_account1_API_KEY（优先）/ account3。account2 为 pi 本体所用，后台避开，防止单账户限流。
       密钥只进环境变量，不落盘、不打印、不写日志。

Usage（项目根 = ROCK_PROJECT_ROOT || cwd）:
    python3 extract_claims_llm.py <paper.json> [--project-id N] [--model sensenova-6.8-flash-lite]
    python3 extract_claims_llm.py --all [--ensure-project "rockburst"]
    python3 extract_claims_llm.py <paper.json> --fallback   # LLM 失败降级启发式

安全：
    - 调用小批量、可中断；论文全文分段送 LLM，不超 maxTokens
    - LLM 输出做 JSON schema 校验，非法结构跳过
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import time
from pathlib import Path

import requests  # geo/base 环境均有

# schema.sql 位置：从本脚本目录 support/scripts/../ 到 support/，再到 rock-research-agent/，然后 extensions/...
# 脚本位置：support/scripts/extract_claims_llm.py → parent=scripts, parent.parent=support, parent.parent.parent=rock-research-agent
SCHEMA = Path(__file__).resolve().parent.parent.parent / "extensions/rock-research/db/schema.sql"
SUBDIRS = ["rockburst", "fracture", "tunnel", "water", "numerical", "other"]

# ── 凭证（最小权限：只读抽取用 key，不读 pi 的 key）──
ENV_FILE = Path.home() / ".env"
DEFAULT_BASE_URL = "https://token.sensenova.cn/v1"
DEFAULT_MODEL = "sensenova-6.8-flash-lite"
# 抽取用 key 候选（按优先级）。SenseNova（~/.env 中 SenseNova2_API_KEY / SenseNova1_API_KEY）。
# 无其他 LLM 回退。pi 对话用 models.json 里的 key，抽取用 ~/.env。
CANDIDATE_KEY_VARS = ["SenseNova_account1_API_KEY", "SenseNova_account3_API_KEY"]  # 后台专用：避开 account2（pi 本体在用）


def load_sensenova_creds(key_var: str | None = None) -> tuple[str, str, str]:
    """从 ~/.env 读抽取用 SenseNova key 与 base_url。密钥不打印。
    返回 (key, base, 使用的变量名)。"""
    if not ENV_FILE.exists():
        raise SystemExit(f"未找到 {ENV_FILE}。请确保含 SenseNova_account1_API_KEY（或 account2/account3）。")
    env: dict[str, str] = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    base = env.get("SENSENOVA_BASE_URL", env.get("LLM_BASE_URL", DEFAULT_BASE_URL))
    candidates = [key_var] if key_var else CANDIDATE_KEY_VARS
    used = key = None
    for name in candidates:
        if name in env and env[name]:
            key = env[name]; used = name; break
    if not key:
        raise SystemExit(f"{ENV_FILE} 中未找到抽取用 SenseNova key（试过 {candidates}）。")
    os.environ["SENSENOVA_API_KEY"] = key  # 只放环境变量，不落盘/不打印
    return key, base, used or ""


# ── LLM 调用（OpenAI 兼容 chat/completions）──

SYS_PROMPT = """你是一个科研 Claim 抽取器。从给定的论文片段中抽取可验证的科学声明（claim）。

【严格验证规则】
1. 每个 claim 的 text 和 text_span 必须在原文中有**逐字匹配**或**极其接近的表述**
2. 禁止编造数值、禁止推断未明确陈述的因果关系
3. 如果原文没有明确支持该 claim，**不要抽取**
4. text_span 必须是原文中的**完整句子**（不能截断导致语义改变）
5. confidence 反映的是 claim 与原文的匹配程度，不是 claim 的重要性

【Claim 类型定义】
- observation: 直接观察到的现象或数据（如：X 值为 Y）
- result: 实验/模拟的主要发现（如：随着 X 增加，Y 减小）
- mechanism: 解释现象的原因或机制（如：X 导致 Y 因为 Z）
- method: 描述研究使用的方法或模型
- interpretation: 对结果的解读或推论
- generalization: 从多个案例中总结的规律
- limitation: 研究的限制或不足

【输出要求】
- 只输出 JSON 数组，不要任何解释
- 每条 claim 必须包含完整的 evidence.text_span（原文引用）
- 如果没有合适的 claim，输出空数组 []

输出格式：
[{"text":"原文中明确陈述的完整句子","claim_type":"result","confidence":0.95,"evidence":{"text_span":"原文中的完整句子（必须与text高度一致）","section":"章节名","evidence_type":"direct","strength":0.95}}]
"""


def call_sensenova(key: str, base: str, model: str, user_content: str, timeout: int = 120) -> list[dict]:
    """调 SenseNova chat/completions，返回 claims 列表。失败抛异常。"""
    url = f"{base.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYS_PROMPT},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.2,  # 低温度，求稳定
        "max_tokens": 8192,  # 单 chunk 抽取的 claims 可能 6-10 条，2048 常截断；8192 容纳绝大多数场景
    }
    # 重试：429 / 5xx / 连接错误最多重试 2 次（1→30s→90s 退避）；4xx 非 429 不重试
    last_err = None
    for attempt in range(3):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=timeout)
        except requests.exceptions.RequestException as e:
            last_err = e
            wait = [60, 180][attempt]
            print(f"  [sensenova] 连接异常 (attempt {attempt+1}/3): {e}; sleep {wait}s", file=sys.stderr)
            time.sleep(wait)
            continue
        # 200
        if resp.status_code == 200:
            break
        # 429 / 5xx 可重试（退避时长更保守，避免继续触发限流）
        if resp.status_code == 429 or 500 <= resp.status_code < 600:
            last_err = RuntimeError(f"HTTP {resp.status_code}")
            wait = [60, 180][attempt]
            print(f"  [sensenova] HTTP {resp.status_code} (attempt {attempt+1}/3); sleep {wait}s", file=sys.stderr)
            time.sleep(wait)
            continue
        # 其他 4xx 直接抛
        resp.raise_for_status()
        break
    else:
        raise last_err or RuntimeError("所有重试失败")

    resp.raise_for_status()
    try:
        content = resp.json()["choices"][0]["message"].get("content") or ""
    except (KeyError, IndexError, TypeError):
        raise ValueError("LLM 响应无 content 字段（可能全被 thinking 消耗）")
    if not content.strip():
        return []  # LLM 未产出可用 content（可能全被 reasoning 消耗）；返回空 claims，不抛错
    content = content.strip()
    # 去 markdown 代码块包裹
    content = re.sub(r"^```(?:json)?\s*", "", content)
    content = re.sub(r"\s*```$", "", content)
    try:
        claims = json.loads(content)
    except json.JSONDecodeError:
        # LLM 有时在字符串里输出原始控制字符，strict=False 容忍之
        claims = json.loads(content, strict=False)
    if not isinstance(claims, list):
        raise ValueError("LLM 输出非 JSON 数组")
    return claims


def validate_claim(c: dict) -> bool:
    """校验单条 claim 结构。"""
    if not isinstance(c, dict):
        return False
    if not c.get("text") or not isinstance(c["text"], str):
        return False
    if c.get("claim_type") not in {"observation", "interpretation", "generalization",
                                    "mechanism", "method", "result", "limitation"}:
        return False
    return True


# ── 分段（控制送 LLM 的 token 量）──

def chunk_sections(doc: dict, max_chars: int = 6000) -> list[tuple[str, str, int]]:
    """返回 [(section_title, text, page), ...]，每段不超过 max_chars。

    降级顺序：sections（只取非空文本）→ 逐页 pages。ingest 时 sections
    可能全为空（只有 title）或完全缺失，都要退回逐页保证不丢内容。
    """
    chunks = []
    if doc.get("abstract"):
        chunks.append(("Abstract", doc["abstract"], 1))
    section_chunks = []
    for sec in (doc.get("sections") or []):
        title = sec.get("title", "") or "(section)"
        text = (sec.get("text") or "").strip()
        page = sec.get("page_start") or 1
        if not text:
            continue
        for i in range(0, len(text), max_chars):
            section_chunks.append((title, text[i:i + max_chars], page))
    if section_chunks:
        chunks.extend(section_chunks)
    else:
        for pg in (doc.get("pages") or []):
            t = (pg.get("text") or "").strip()
            if t:
                for i in range(0, len(t), max_chars):
                    chunks.append((f"(page {pg.get('number',1)})", t[i:i + max_chars], pg.get("number", 1)))
    return chunks


def project_root() -> Path:
    return Path(os.environ.get("ROCK_PROJECT_ROOT") or os.getcwd()).resolve()


def open_db(root: Path) -> sqlite3.Connection:
    data_dir = root / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(root / "data" / "research.db"))
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA.read_text(encoding="utf-8"))
    conn.commit()
    return conn


def ensure_project(conn: sqlite3.Connection, name: str) -> int:
    row = conn.execute("SELECT id FROM projects WHERE name = ?", (name,)).fetchone()
    if row:
        return row["id"]
    cur = conn.execute("INSERT INTO projects (name, description) VALUES (?, ?)",
                       (name, f"auto-created by extract_claims_llm"))
    conn.commit()
    return cur.lastrowid


def write_claim(conn: sqlite3.Connection, project_id: int, c: dict, file_path: str,
                default_section: str, default_page: int) -> bool:
    """写一条 claim + 其 evidence。返回是否成功。
    去重规则：相同的 (text, file_path) 只保留一条，跳过重复。
    """
    if not validate_claim(c):
        return False
    
    # 去重检查：相同的 text + file_path 已存在则跳过
    existing = conn.execute(
        "SELECT id FROM claims WHERE text = ? AND project_id = ?",
        (c["text"], project_id)
    ).fetchone()
    if existing:
        # 检查是否已有该 file_path 的证据
        has_evidence = conn.execute(
            "SELECT 1 FROM evidence WHERE claim_id = ? AND file_path = ? LIMIT 1",
            (existing["id"], file_path)
        ).fetchone()
        if has_evidence:
            return False  # 已存在，跳过
    
    ev = c.get("evidence") or {}
    
    if existing:
        claim_id = existing["id"]
    else:
        cur = conn.execute(
            "INSERT INTO claims (project_id, text, claim_type, confidence) VALUES (?, ?, ?, ?)",
            (project_id, c["text"], c.get("claim_type", "observation"),
             min(max(float(c.get("confidence", 0.5)), 0.0), 1.0)))
        claim_id = cur.lastrowid
    
    conn.execute(
        "INSERT OR IGNORE INTO evidence (claim_id, paper_id, source_type, file_path, page, section, "
        "text_span, evidence_type, strength) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (claim_id, None, "paper", file_path,
         ev.get("page") or default_page,
         ev.get("section") or default_section,
         ev.get("text_span", c["text"])[:500],
         ev.get("evidence_type", "direct"),
         min(max(float(ev.get("strength", 0.6)), 0.0), 1.0)))
    
    # 更新 evidence_strength（取该 claim 所有证据的最大 strength）
    conn.execute(
        "UPDATE claims SET evidence_strength = (\n            SELECT MAX(e.strength) FROM evidence e WHERE e.claim_id = claims.id\n        ) WHERE id = ?",
        (claim_id,)
    )
    
    return True


# ── 主流程 ──

def ingest_paper(conn, json_path, project_id, key, base, model, fallback):
    doc = json.loads(json_path.read_text(encoding="utf-8"))
    fp = doc.get("file_path") or str(json_path)
    chunks = chunk_sections(doc)
    total = 0
    for title, text, page in chunks:
        user_msg = f"论文标题: {doc.get('title','')}\n章节: {title}\n页码: {page}\n\n正文:\n{text}"
        try:
            claims = call_sensenova(key, base, model, user_msg)
        except Exception as e:
            print(f"  [{title}] LLM 调用失败: {e}", file=sys.stderr)
            if fallback:
                # 降级：用启发式抽这段
                claims = heuristic_extract(text, title, page)
            else:
                continue
        n = 0
        for c in claims:
            if write_claim(conn, project_id, c, fp, title, page):
                n += 1
        # 每 chunk 立即提交：缩短写锁窗口（毫秒级），
        # 否则长论文在逐页调 LLM 的几分钟里一直占着未提交事务
        conn.commit()
        total += n
        if n:
            print(f"  [{title}] +{n} claims")
        import random as _rand
        time.sleep(_rand.uniform(5.0, 10.0))  # 随机 5~10s 延迟，避免触发 API 限流
    conn.commit()
    return total


def heuristic_extract(text: str, title: str, page: int) -> list[dict]:
    """启发式降级（复用 extract_claims.py 的打分逻辑）。"""
    QUANT = re.compile(r"\d+(\.\d+)?\s*(MPa|GPa|kN|%|mm|cm|m|s|Hz)|\d+(\.\d+)?%|\d+\s?倍")
    CAUSAL = re.compile(r"(导致|引起|使得|thus|therefore|causes?|leads? to|results? in|due to)", re.I)
    out = []
    for sent in re.split(r"(?<=[\.\!\?。！？])\s+|\n+|；|;", text):
        s = sent.strip()
        if not (30 < len(s) < 400):
            continue
        score = (2.0 if QUANT.search(s) else 0) + (1.0 if CAUSAL.search(s) else 0)
        if score > 0:
            out.append({"text": s, "claim_type": "result", "confidence": min(0.5 + score * 0.1, 0.9),
                        "evidence": {"text_span": s, "section": title, "evidence_type": "direct",
                                     "strength": min(0.4 + score * 0.1, 0.8)}})
    return out[:8]


def find_paper_jsons(root: Path, stem: str | None) -> list[Path]:
    papers = root / "paper-raw"
    if not papers.exists():
        return []
    if stem:
        for cand in [papers / f"{stem}.json", *(papers / s / f"{stem}.json" for s in SUBDIRS)]:
            if cand.exists():
                return [cand]
        return []
    return sorted(papers.rglob("*.json"))


def main():
    ap = argparse.ArgumentParser(description="Rock LLM 级 Claim 抽取（项目级）")
    ap.add_argument("paper", nargs="?")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--project-id", type=int)
    ap.add_argument("--ensure-project", metavar="NAME")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--fallback", action="store_true", help="LLM 失败降级启发式")
    ap.add_argument("--key-var", default=None,
                    help="指定 ~/.env 中读取的 key 变量名（默认 SenseNova_account1→account3，避开 pi 本体的 account2）")
    args = ap.parse_args()

    root = project_root()
    key, base, used_var = load_sensenova_creds(args.key_var)
    conn = open_db(root)
    if args.project_id:
        pid = args.project_id
    elif args.ensure_project:
        pid = ensure_project(conn, args.ensure_project)
    else:
        row = conn.execute("SELECT id FROM projects ORDER BY id LIMIT 1").fetchone()
        pid = row["id"] if row else ensure_project(conn, "default")

    if args.all:
        targets = find_paper_jsons(root, None)
    elif args.paper:
        p = Path(args.paper)
        targets = [p] if (p.suffix == ".json" and p.exists()) else find_paper_jsons(root, args.paper.replace(".pdf", "").replace(".json", ""))
    else:
        ap.error("需提供 paper 或 --all")

    if not targets:
        print(f"未找到论文 JSON。先运行: ingest_pdf.py <pdf> --output {root}/paper-raw/", file=sys.stderr)
        sys.exit(1)

    print(f"模型: {args.model} | endpoint: {base} | key: {used_var} | 项目: {root.name} (pid={pid})")
    total = 0
    for jf in targets:
        print(f"\n处理 {jf.name}...")
        total += ingest_paper(conn, jf, pid, key, base, args.model, args.fallback)
    conn.close()
    print(f"\n完成：LLM 抽取 {total} 条 Claim，写入 {root}/data/research.db")


if __name__ == "__main__":
    main()
