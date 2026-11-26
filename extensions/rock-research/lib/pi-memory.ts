/**
 * pi-memory.ts — pi 本地记忆库（SQLite + FTS5 trigram），分级主动检索。
 *
 * 数据根：`ROCK_MEMORY_DIR` 或 `~/.pi/memory-data`
 * 库文件：`ROCK_MEMORY_DB` 或 `<数据根>/pi_memory.db`
 *   —— 不触碰既有 nanobot_memory.db（只读迁移），也不生成任何 md 文件。
 *
 * 分级（tier）：
 *   0  用户事实与偏好             dream/user_facts/*.md（memory_dream 蒸馏沉淀）
 *   1  技能与流程                 workskills/<skill>/SKILL.md、workflows/*.md、dream/workflows/*.md
 *   2  参考资料与技术笔记          workskills 其余 md、technotes、dream/notes、.dreams、research-wiki、history、conflicts
 *   3  历史记忆条目               nanobot_memory.db 的 semantic / episodic / procedural
 *
 * MEMORY.md 与 user_facts/ 自 2026-10-26 起废弃，不再作为 tier 0 来源扫描：记忆一律走
 * lib/pi-dream.ts 的 memory_add → memory_dream 流水线，产物集中落在 dream/ 下（原文件迁入
 * .retired/，内容已合并为 dream/user_facts/legacy-2026-07.md 保留可检索性）。
 *
 * 检索策略（为效率与中文召回同时优化）：
 *   1) FTS5 `tokenize='trigram'`：任意 ≥3 字符子串可精确匹配（中英混排皆可），BM25 排序；
 *   2) 1~2 字中文短查询 trigram 无法命中 → 回退 `LIKE` 扫描（全表 ~5MB，数十毫秒），标题/摘要命中加权；
 *   3) 英文短词额外做词边界校验并剔除「假命中」（否则 THM 会命中 rhythm），
 *      最终先按「命中了几个查询词」排序，再按路径内排序。
 * 增量重建：按 (source, path, bytes) 跳过未变文件，最后 `mem_fts('rebuild')` 重建索引。
 */

import Database from "better-sqlite3";
import { readFileSync, readdirSync, existsSync, statSync, mkdirSync } from "fs";
import { join, dirname, basename, relative, extname, sep } from "path";
import { homedir } from "os";

type DB = InstanceType<typeof Database>;

// ── 分级标签 ────────────────────────────────────────────────────────────────

export const TIER_LABEL: Record<number, string> = {
  0: "长期记忆/用户事实（身份、活跃项目、偏好）",
  1: "技能与流程（SKILL.md、workflow）",
  2: "参考资料与技术笔记（references、technotes、dreams、history）",
  3: "历史记忆条目（nanobot semantic/episodic/procedural）",
};

export type Tier = 0 | 1 | 2 | 3;

// ── 路径解析（可覆盖，不写死用户目录） ─────────────────────────────────────

export function memoryDir(): string {
  const override = process.env.ROCK_MEMORY_DIR?.trim();
  if (override) return override.replace(/\/+$/, "");
  return join(homedir(), ".pi", "memory-data");
}

export function memoryDbFile(): string {
  const override = process.env.ROCK_MEMORY_DB?.trim();
  if (override) return override;
  return join(memoryDir(), "pi_memory.db");
}

export function nanobotDbFile(): string {
  return join(memoryDir(), "nanobot_memory.db");
}

// ── 连接与建表 ──────────────────────────────────────────────────────────────

let _db: DB | null = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;
PRAGMA mmap_size = 268435456;
PRAGMA temp_store = MEMORY;

CREATE TABLE IF NOT EXISTS mem_doc (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tier       INTEGER NOT NULL DEFAULT 3,
  source     TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'doc',
  title      TEXT NOT NULL DEFAULT '',
  summary    TEXT NOT NULL DEFAULT '',
  keywords   TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL DEFAULT '',
  storage    TEXT NOT NULL DEFAULT 'disk',
  bytes      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(source, path)
);
CREATE INDEX IF NOT EXISTS idx_mem_tier   ON mem_doc(tier);
CREATE INDEX IF NOT EXISTS idx_mem_source ON mem_doc(source);
CREATE INDEX IF NOT EXISTS idx_mem_kind   ON mem_doc(kind);

CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
  title, summary, body, keywords,
  content='mem_doc', content_rowid='id',
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS mem_meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`;

export function ensureSchema(db: DB): void {
  db.exec(SCHEMA);
}

/** 打开（必要时创建）记忆库；同一进程内复用同一连接。 */
export function openMemoryDb(rebuild = false): DB {
  if (_db && !rebuild) return _db;
  const file = memoryDbFile();
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("busy_timeout = 5000");
  ensureSchema(db);
  _db = db;
  return db;
}

export function closeMemoryDb(): void {
  try { _db?.close(); } catch { /* ignore */ }
  _db = null;
}

export function metaGet(db: DB, k: string): string | undefined {
  return (db.prepare("SELECT v FROM mem_meta WHERE k = ?").get(k) as { v: string } | undefined)?.v;
}

export function metaSet(db: DB, k: string, v: string): void {
  db.prepare("INSERT INTO mem_meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}

// ── 文本工具 ────────────────────────────────────────────────────────────────

/** 读取文本：严格 UTF-8 优先，失败则宽松解码（该目录下的 md/MEMORY.md 实测均为 UTF-8）。 */
export function readText(file: string): { text: string; replaced: boolean } {
  const buf = readFileSync(file);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), replaced: false };
  } catch {
    const text = new TextDecoder("utf-8").decode(buf);
    return { text, replaced: text.includes("\uFFFD") };
  }
}

/** 解析 YAML frontmatter（只取顶层 key: value，够用于 SKILL.md）。 */
function parseFrontmatter(text: string): { meta: Map<string, string>; body: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { meta: new Map(), body: text };
  const meta = new Map<string, string>();
  for (let i = 1; i < Math.min(lines.length, 60); i++) {
    const line = lines[i];
    if (line.trim() === "---" || line.trim() === "...") {
      return { meta, body: lines.slice(i + 1).join("\n") };
    }
    const m = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (m) meta.set(m[1].toLowerCase(), m[2].trim());
  }
  return { meta: new Map(), body: text };
}

/** 首个非标题、非代码块、非表格的段落作为摘要。 */
function firstParagraph(text: string, max = 280): string {
  const lines = text.split(/\r?\n/);
  let buf: string[] = [];
  let inFence = false;
  const push = () => {
    const s = buf.join(" ").replace(/\s+/g, " ").trim();
    if (s.length >= 12) return s.length > max ? s.slice(0, max) + "…" : s;
    return "";
  };
  for (const line of lines) {
    const t = line.trim();
    if (/^```/.test(t)) { inFence = !inFence; continue; }
    if (inFence || !t || /^#{1,6}\s/.test(t) || /^[-*+]\s/.test(t) || /^\|/.test(t) || /^={3,}$/.test(t)) continue;
    if (/^---\s*$/.test(t)) continue;
    buf.push(t);
    if (buf.join(" ").length >= 12) {
      const out = push();
      if (out) return out;
    }
  }
  return "";
}

/** 抽取 #hashtag 关键词 + 显式 tags 字段。 */
function extractKeywords(text: string, extra?: string): string {
  const set = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s"'(])#([A-Za-z0-9_\u2010-\u2015\u4e00-\u9fa5]{2,40})/g)) {
    set.add(m[1]);
  }
  if (extra) {
    for (const t of extra.split(/[,;/|、]+/)) {
      const s = t.trim().replace(/[\[\]{}"]/g, "");
      if (s.length >= 2 && s.length <= 40) set.add(s);
    }
  }
  return [...set].slice(0, 40).join(" ");
}

function cleanPath(p: string, root: string): string {
  return relative(root, p).split(sep).join("/");
}

// ── 扫描：md 文件 → 文档行 ──────────────────────────────────────────────────

interface DocRow {
  tier: Tier;
  source: string;
  kind: string;
  title: string;
  summary: string;
  keywords: string;
  body: string;
  path: string;
  storage: 'disk' | 'inline';
  bytes: number;
  created_at: string | null;
  updated_at: string | null;
}

function mdDoc(root: string, file: string, tier: Tier, source: string, kind: string): DocRow {
  const { text, replaced } = readText(file);
  const { meta, body } = parseFrontmatter(text);
  const h1 = text.split(/\r?\n/).find((l) => /^#\s+\S/.test(l.trim()));
  const stem = basename(file, extname(file));
  const title =
    (meta.get("name") || (h1 ? h1.trim().replace(/^#\s*/, "") : "") || stem).slice(0, 200);
  const summary = (meta.get("description") || firstParagraph(body)).slice(0, 320);
  const keywords = extractKeywords(text, meta.get("tags"));
  const ts = statSync(file);
  const rel = cleanPath(file, root);
  // disk 源：body 只存摘要快照（前 500 字符），避免与磁盘 md 双重存储
  // FTS5 仍能索引这个摘要，memory_get 会从磁盘读全文
  const fullText = replaced ? text + "\n<!-- 编码非严格 UTF-8，已宽松解码 -->" : text;
  const bodySnapshot = fullText.slice(0, 500);
  return {
    tier,
    source,
    kind,
    title,
    summary,
    keywords,
    body: bodySnapshot,
    path: rel,
    storage: 'disk',
    bytes: ts.size,
    created_at: ts.birthtime.toISOString(),
    updated_at: ts.mtime.toISOString(),
  };
}

/** 内容的短哈希（FNV-1a），用于日志类条目的唯一 path（history.jsonl 的 cursor 可能重复）。 */
function hash6(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

/** 列出目录下（可含隐藏子目录）的所有 md 文件。 */
function listMd(dir: string, acc: string[], followHidden = false): string[] {
  let ents: ReturnType<typeof readdirSync>;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    if (e.name.startsWith(".") && !followHidden) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) listMd(full, acc, followHidden);
    else if (extname(e.name).toLowerCase() === ".md") acc.push(full);
  }
  return acc;
}

// ── 扫描：JSON / JSONL / nanobot ────────────────────────────────────────────

function historyDocs(root: string, file: string): DocRow[] {
  const { text } = readText(file);
  const rel = cleanPath(file, root);
  const rows: DocRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let o: Record<string, unknown> | null = null;
    try { o = JSON.parse(t) as Record<string, unknown>; } catch { continue; }
    const ts = String(o.timestamp ?? "");
    const cur = String(o.cursor ?? "");
    const content = String(o.content ?? "");
    if (!content) continue;
    rows.push({
      tier: 2,
      source: "history",
      kind: "entry",
      title: `${ts} #${cur}`.trim().slice(0, 200),
      summary: content.replace(/\s+/g, " ").slice(0, 300),
      keywords: extractKeywords(content),
      body: content,
      path: `${rel}#${cur || "n"}_${hash6(content)}`,
      storage: 'disk',
      bytes: Buffer.byteLength(content),
      created_at: ts || null,
      updated_at: ts || null,
    });
  }
  return rows;
}

function conflictDocs(root: string, file: string): DocRow[] {
  const { text } = readText(file);
  const rel = cleanPath(file, root);
  let o: { conflicts?: unknown[]; stats?: unknown };
  try { o = JSON.parse(text) as typeof o; } catch { return []; }
  return (o.conflicts || []).map((c, i) => {
    const e = c as Record<string, unknown>;
    const id = String(e.id ?? i);
    const type = String(e.type ?? "conflict");
    const kw = String(e.keyword ?? "");
    const preview = String(e.content_preview ?? "");
    const title = `${type}${kw ? " · " + kw : ""} ${id}`.slice(0, 200);
    const body = `type: ${type}\nkeyword: ${kw}\ndetected_at: ${e.detected_at ?? ""}\nentry: ${e.entry_timestamp ?? ""} (cursor ${e.entry_cursor ?? ""})\nsource: ${e.source ?? ""}\n\n${preview}`;
    return {
      tier: 2 as Tier, source: "conflict", kind: "conflict", title,
      summary: preview.replace(/\s+/g, " ").slice(0, 300),
      keywords: extractKeywords(body, kw), body, path: `${rel}#${id}`,
      storage: 'disk',
      bytes: Buffer.byteLength(body), created_at: String(e.detected_at ?? "") || null, updated_at: null,
    };
  });
}

function nanobotDocs(db: DB): DocRow[] {
  const rows: DocRow[] = [];
  const field = (o: Record<string, unknown>, k: string): string => {
    const v = o[k];
    if (v == null) return "";
    return typeof v === "string" ? v : JSON.stringify(v);
  };

  for (const r of db.prepare("SELECT * FROM semantic_memories").all() as Record<string, unknown>[]) {
    const title = [field(r, "subject"), field(r, "predicate"), field(r, "object_value")].filter(Boolean).join(" / ");
    if (!title) continue;
    const body = [
      `knowledge_type: ${field(r, "knowledge_type")}`,
      `subject: ${field(r, "subject")}`,
      `predicate: ${field(r, "predicate")}`,
      `object_value: ${field(r, "object_value")}`,
      field(r, "context") ? `context: ${field(r, "context")}` : "",
      field(r, "examples") ? `examples: ${field(r, "examples")}` : "",
      field(r, "review_note") ? `review_note: ${field(r, "review_note")}` : "",
      `source_file: ${field(r, "source_file")} | source_events: ${field(r, "source_events")}`,
      `status: ${field(r, "status")} | confidence: ${field(r, "confidence")} | importance: ${field(r, "importance")}`,
      `scope: ${field(r, "scope")} | partition: ${field(r, "partition")}`,
      `tags: ${field(r, "tags")} | updated_at: ${field(r, "updated_at")}`,
    ].filter(Boolean).join("\n");
    rows.push({
      tier: 3, source: "nanobot_semantic", kind: "fact", title,
      summary: `${title} · ${field(r, "context")}`.slice(0, 300),
      keywords: extractKeywords(body, field(r, "tags")), body,
      path: `nanobot:semantic#${field(r, "id")}`, storage: 'inline', bytes: Buffer.byteLength(body),
      created_at: field(r, "created_at") || null, updated_at: field(r, "updated_at") || null,
    });
  }

  for (const r of db.prepare("SELECT * FROM episodic_memories").all() as Record<string, unknown>[]) {
    const title = field(r, "title") || field(r, "event_type") || "episode";
    const body = [
      `title: ${field(r, "title")}`,
      `summary: ${field(r, "summary")}`,
      field(r, "content") && field(r, "content") !== field(r, "summary") ? `content: ${field(r, "content")}` : "",
      `event_type: ${field(r, "event_type")} | actor: ${field(r, "actor_id")} | session: ${field(r, "session_id")}`,
      `entities: ${field(r, "entities")}`,
      `tags: ${field(r, "tags")} | file_path: ${field(r, "file_path")}`,
      `importance: ${field(r, "importance")} | status: ${field(r, "status")} | scope: ${field(r, "scope")} | partition: ${field(r, "partition")}`,
      `event_time: ${field(r, "event_time")} | created_at: ${field(r, "created_at")}`,
    ].filter(Boolean).join("\n");
    rows.push({
      tier: 3, source: "nanobot_episodic", kind: "episode", title,
      summary: (field(r, "summary") || field(r, "content")).replace(/\s+/g, " ").slice(0, 300),
      keywords: extractKeywords(body, field(r, "tags")), body,
      path: `nanobot:episodic#${field(r, "id")}`, storage: 'inline', bytes: Buffer.byteLength(body),
      created_at: field(r, "created_at") || null, updated_at: null,
    });
  }

  for (const r of db.prepare("SELECT * FROM procedural_memories").all() as Record<string, unknown>[]) {
    const title = field(r, "skill_name") || "procedure";
    const body = [
      `skill_name: ${field(r, "skill_name")}`,
      `description: ${field(r, "description")}`,
      field(r, "trigger_config") ? `trigger: ${field(r, "trigger_type")} ${field(r, "trigger_config")}` : "",
      field(r, "steps") ? `steps: ${field(r, "steps")}` : "",
      `file_path: ${field(r, "file_path")}`,
      `category: ${field(r, "category")} | scope: ${field(r, "scope")} | partition: ${field(r, "partition")}`,
      `status: ${field(r, "status")} | use_count: ${field(r, "use_count")} | success_rate: ${field(r, "success_rate")}`,
      `updated_at: ${field(r, "updated_at")}`,
    ].filter(Boolean).join("\n");
    rows.push({
      tier: 3, source: "nanobot_procedural", kind: "procedure", title,
      summary: field(r, "description").slice(0, 300),
      keywords: extractKeywords(body, field(r, "category")), body,
      path: `nanobot:procedural#${field(r, "id")}`, storage: 'inline', bytes: Buffer.byteLength(body),
      created_at: field(r, "created_at") || null, updated_at: field(r, "updated_at") || null,
    });
  }
  return rows;
}

// ── 全量扫描 ────────────────────────────────────────────────────────────────

/**
 * 明确排除的顶层目录：inbox（暂存区，未沉淀不可检索）/ .retired（归档）/ .dream_tmp（蒸馏流水临时）。
 * 这三个目录「不进索引」过去是靠漏写一条 addMd 实现的——任何人在下面加一行就会静默破坏
 * 「md 不存信息、轻装上阵、靠 agent 主动检索」的核心不变量。所以除了不在 scanSources 里写它们，
 * 产出后再兜一遍，让违规可见而不是靠调用方记得别加。
 */
export const EXCLUDED_PREFIXES = ["inbox", ".retired", ".dream_tmp"] as const;

export function isExcludedPath(relPath: string): boolean {
  return EXCLUDED_PREFIXES.some((p) => relPath === p || relPath.startsWith(`${p}/`));
}

function scanSources(): DocRow[] {
  const root = memoryDir();
  const rows: DocRow[] = [];
  const sub = (n: string) => join(root, n);
  const addMd = (dir: string, tier: Tier, source: string, kind: string, skip: string[] = [], hidden = false, nameTest?: (n: string) => boolean) => {
    for (const f of listMd(dir, [], hidden)) {
      if (skip.includes(cleanPath(f, root))) continue;
      if (nameTest && !nameTest(basename(f))) continue;
      rows.push(mdDoc(root, f, tier, source, kind));
    }
  };

  // tier 0：dream 蒸馏出的用户事实（MEMORY.md 与 user_facts/ 已废弃，见文件头）
  addMd(sub("dream/user_facts"), 0, "dream_fact", "fact");

  // tier 1：workskills/*/SKILL.md + workflows
  const ws = sub("workskills");
  if (existsSync(ws)) {
    for (const e of readdirSync(ws, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const skillMd = join(ws, e.name, "SKILL.md");
      if (existsSync(skillMd)) rows.push(mdDoc(root, skillMd, 1, "workskill", "skill"));
    }
  }
  addMd(sub("workflows"), 1, "workflow", "workflow");
  addMd(sub("dream/workflows"), 1, "dream_workflow", "workflow");

  // tier 2：workskills 其余 md / technotes / .dreams / research-wiki
  if (existsSync(ws)) {
    for (const e of readdirSync(ws, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const dir = join(ws, e.name);
      const self = cleanPath(join(dir, "SKILL.md"), root);
      for (const f of listMd(dir, [])) {
        if (cleanPath(f, root) === self) continue;
        const rel = cleanPath(f, root);
        const kind = rel.includes("/references/") ? "reference" : rel.includes("/static/") ? "skill_asset" : "skill_doc";
        rows.push(mdDoc(root, f, 2, "skill_ref", kind));
      }
    }
  }
  addMd(sub("technotes"), 2, "technote", "note");
  addMd(sub("dream/notes"), 2, "dream_note", "note");
  // .dreams：只索引 memory_dream 自己的运行报告（dream-<yyyymmdd>-<hhmmss>.md）。
  // 该目录历史上堆了 130 余篇旧架构的 moonlight_*/deep_report/rem_report 复盘，与本项目的记忆无关
  // 却共享 source=dream，会让 memory_search 命中三个月前的月相报告；dry_run 报告写成
  // dream-dryrun-<时间>.md，同样不索引（干跑计划不是知识，不该被检索回来）。
  addMd(sub(".dreams"), 2, "dream", "dream", [], true, (n) => /^dream-\d{8}-\d{6}\.md$/.test(n));
  addMd(sub("research-wiki"), 2, "research_wiki", "doc");

  // tier 2：history.jsonl + conflict_queue.json
  const hist = sub("history.jsonl");
  if (existsSync(hist)) rows.push(...historyDocs(root, hist));
  const cq = sub("conflict_queue.json");
  if (existsSync(cq)) rows.push(...conflictDocs(root, cq));

  // 兜底护栏：任何来源（含 nanobot 之外的手工增补）都不允许把排除目录带进来
  return rows.filter((r) => !isExcludedPath(r.path));
}

// ── 增量重建索引 ────────────────────────────────────────────────────────────

export interface ReindexStats {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  fts_rebuilt: boolean;
  nanobot_rows: number;
  nanobot_missing: boolean;
  total_docs: number;
  total_bytes: number;
  by_source: Record<string, number>;
  elapsed_ms: number;
  db_file: string;
  warnings: string[];
}

export function scanAndIndex(db: DB, opts: { dryRun?: boolean } = {}): ReindexStats {
  const t0 = Date.now();
  const warnings: string[] = [];
  const root = memoryDir();
  const stats: ReindexStats = {
    added: 0, updated: 0, unchanged: 0, removed: 0, fts_rebuilt: false,
    nanobot_rows: 0, nanobot_missing: false, total_docs: 0, total_bytes: 0,
    by_source: {}, elapsed_ms: 0, db_file: memoryDbFile(), warnings,
  };

  const rows = scanSources();

  // tier-3 历史记忆（nanobot_*）已迁移为 inline 存储，不再从 nanobot_memory.db 读取。
  // 旧库已删除，mem_doc 里 storage='inline' 的记录由 diff 逻辑保护不被误删。

  for (const r of rows) stats.by_source[r.source] = (stats.by_source[r.source] ?? 0) + 1;

  // 先与库中现有文档比对得出 diff；dry_run 只算不改，实跑按同一 diff 写库。
  // 注意：storage='inline' 的记录不参与 diff 删除（它们是 DB 直源，无磁盘对应文件）。
  const existing = db
    .prepare("SELECT source, path, id, bytes, storage FROM mem_doc")
    .all() as { source: string; path: string; id: number; bytes: number; storage: string }[];
  const idx = new Map<string, { id: number; bytes: number; storage: string }>();
  for (const e of existing) idx.set(`${e.source}\u0000${e.path}`, { id: e.id, bytes: e.bytes, storage: e.storage });
  const seen = new Set(rows.map((r) => `${r.source}\u0000${r.path}`));

  for (const r of rows) {
    const old = idx.get(`${r.source}\u0000${r.path}`);
    if (!old) stats.added++;
    else if (old.bytes === r.bytes) stats.unchanged++;
    else stats.updated++;
  }
  // diff 删除：跳过 storage='inline' 的记录
  for (const [key, doc] of idx) {
    if (doc.storage === 'inline') continue;
    if (!seen.has(key)) stats.removed++;
  }

  const upsert = db.prepare(`
    INSERT INTO mem_doc(tier, source, kind, title, summary, keywords, body, path, storage, bytes, created_at, updated_at)
    VALUES (@tier, @source, @kind, @title, @summary, @keywords, @body, @path, @storage, @bytes, @created_at, @updated_at)
    ON CONFLICT(source, path) DO UPDATE SET
      tier=@tier, kind=@kind, title=@title, summary=@summary, keywords=@keywords,
      body=@body, storage=@storage, bytes=@bytes, created_at=@created_at, updated_at=@updated_at
  `);
  const del = db.prepare("DELETE FROM mem_doc WHERE id = ?");

  if (!opts.dryRun) {
    const tx = db.transaction(() => {
      for (const r of rows) {
        const old = idx.get(`${r.source}\u0000${r.path}`);
        if (old && old.bytes === r.bytes) continue;
        upsert.run(r);
      }
      // 只删除 disk 源中已消失的记录，inline 源保留
      for (const [key, { id, storage }] of idx) {
        if (storage === 'inline') continue;
        if (!seen.has(key)) del.run(id);
      }
    });
    tx();
    // mem_fts 为外部内容表，mem_doc 变动后必须重建索引，否则检索结果陈旧
    db.prepare("INSERT INTO mem_fts(mem_fts) VALUES('rebuild')").run();
    stats.fts_rebuilt = true;
  }

  const totals = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(bytes),0) AS b FROM mem_doc").get() as { c: number; b: number };
  stats.total_docs = totals.c;
  stats.total_bytes = totals.b;
  stats.elapsed_ms = Date.now() - t0;

  if (!opts.dryRun) {
    metaSet(db, "last_reindex_at", new Date().toISOString());
    metaSet(db, "last_reindex_docs", String(totals.c));
    metaSet(db, "last_reindex_root", root);
    metaSet(db, "last_reindex_warnings", warnings.join(" | "));
  }
  return stats;
}

// ── 检索 ────────────────────────────────────────────────────────────────────

export interface SearchOpts {
  query: string;
  tier?: Tier | number;
  source?: string;
  kind?: string;
  limit?: number;
}

export interface MemoryHit {
  id: number;
  tier: number;
  tier_label: string;
  source: string;
  kind: string;
  title: string;
  summary: string;
  snippet: string;
  score: number;
  via: "fts" | "like";
  path: string;
  bytes: number;
}

const STOP = new Set(["的", "了", "是", "在", "和", "与", "及", "对", "把", "被", "从", "为", "到", "也", "都", "就", "而", "之"]);

export function splitTerms(query: string): string[] {
  const parts = query
    .split(/[\s,;、，；|/\\：:]+/)
    .map((s) => s.replace(/^["'`「]+|["'`」]+$/g, "").trim())
    .filter((s) => s.length > 0 && !STOP.has(s));
  return parts.slice(0, 8);
}

function ftsPhrase(term: string): string {
  return '"' + term.replace(/"/g, '""') + '"';
}

function makeSnippet(text: string, terms: string[], radius = 110): string {
  let best = -1;
  for (const t of terms) {
    const i = findTerm(text, t).at;
    if (i >= 0 && (best < 0 || i < best)) best = i;
  }
  if (best < 0) return text.replace(/\s+/g, " ").trim().slice(0, radius * 2);
  const s = Math.max(0, best - radius);
  const e = Math.min(text.length, best + radius);
  const seg = text.slice(s, e).replace(/\s+/g, " ").trim();
  return (s > 0 ? "…" : "") + seg + (e < text.length ? "…" : "");
}

function countOccurrence(haystack: string, needle: string): number {
  return findTerm(haystack, needle).count;
}

/** 查询词在文本中的匹配位置与次数。纯 ASCII 词按「词边界」匹配（避免 THM 命中 rhythm），其余按子串。 */
function findTerm(text: string, term: string): { at: number; count: number } {
  const lower = term.toLowerCase();
  if (!lower) return { at: -1, count: 0 };
  const isAscii = /^[a-z0-9_]+$/.test(lower);
  if (isAscii) {
    const re = new RegExp("(?<![a-z0-9_])" + lower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![a-z0-9_])", "gi");
    let count = 0;
    let at = -1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      count += 1;
      if (at < 0) at = m.index;
      if (count > 64) break;
    }
    return { at, count };
  }
  const h = text.toLowerCase();
  let count = 0;
  let from = 0;
  let idx = h.indexOf(lower);
  const at = idx;
  while (idx !== -1) {
    count += 1;
    if (count > 64) break;
    from = idx + lower.length;
    idx = h.indexOf(lower, from);
  }
  return { at, count };
}

/** 长中文短语（≥5 字）拆成 2 字分段：整串在库里不存在时仍能召回（论文下载流程 → 论文+下载+流程）。 */
function chunk2(t: string): string[] {
  const s: string[] = [];
  for (let i = 0; i + 2 <= t.length; i += 2) s.push(t.slice(i, i + 2));
  return s.length > 0 ? s : [t];
}

/** 单个查询词是否命中：短词按词边界精确判定；长中文短语按其 2 字分段是否全部出现判定。 */
function termHit(hay: string, term: string): boolean {
  if (term.length >= 5 && /[\u4e00-\u9fff]/.test(term)) {
    for (const p of chunk2(term)) if (findTerm(hay, p).count === 0) return false;
    return true;
  }
  return findTerm(hay, term).count > 0;
}

/** 查询词中有多少个词真的出现在该文档里——多词查询的一级排序依据。 */
function hitTerms(title: string, body: string, terms: string[]): number {
  const hay = title + "\u0001" + body;
  let n = 0;
  for (const t of terms) if (termHit(hay, t)) n++;
  return n;
}

/**
 * 分级检索。三条路径叠加，最后统一排序：
 *  1. FTS5 trigram（BM25）：匹配 ≥3 字符的任意子串，中英混排皆可；
 *  2. LIKE：1~2 字词（trigram 匹配不了）；
 *  3. LIKE 分段：≥5 字中文短语拆成 2 字片段 AND（整串不存在也能召回）。
 * 英文短词按词边界判定并剔除假命中（否则 THM 会命中 rhythm），
 * 最终先按「命中了几个查询词」排序，再按路径内排序（BM25 / 标题加权）。
 */
export function memorySearch(db: DB, opts: SearchOpts): MemoryHit[] {
  const limit = Math.max(1, Math.min(20, Math.round(opts.limit ?? 8)));
  const terms = splitTerms(opts.query);
  if (terms.length === 0) return [];

  const filters: string[] = [];
  const params: (string | number)[] = [];
  if (opts.tier !== undefined) { filters.push("d.tier = ?"); params.push(Number(opts.tier)); }
  if (opts.source) { filters.push("d.source = ?"); params.push(opts.source); }
  if (opts.kind) { filters.push("d.kind = ?"); params.push(opts.kind); }
  const where = filters.length ? "AND " + filters.join(" AND ") : "";

  const ftsTerms = terms.filter((t) => t.length >= 3);
  // LIKE 侧的匹配分组：组内片段须同时命中（AND），组间也 AND
  //  · 1~2 字词 → 独立一组（trigram 匹配不了 <3 字符）
  //  · ≥5 字中文短语 → 拆 2 字分段一组（整串在库里不存在时仍能召回）
  const groups: string[][] = [];
  let totalParts = 0;
  for (const t of terms) {
    const g = t.length < 3 ? [t] : t.length >= 5 && /[\u4e00-\u9fff]/.test(t) ? chunk2(t) : null;
    if (!g) continue;
    if (totalParts + g.length > 12) break;   // 防止 LIKE 谓词爆炸
    groups.push(g);
    totalParts += g.length;
  }
  const likeTerms = groups.flat();
  const seen = new Set<number>();
  const ranked: { hit: MemoryHit; terms_hit: number; order: number }[] = [];

  // 1) FTS5 trigram
  if (ftsTerms.length > 0) {
    const matchExpr = ftsTerms.map(ftsPhrase).join(" OR ");
    const sql = `
      SELECT d.id, d.tier, d.source, d.kind, d.title, d.summary, d.body, d.path, d.bytes,
             bm25(mem_fts) AS s
      FROM mem_fts
      JOIN mem_doc d ON d.id = mem_fts.rowid
      WHERE mem_fts MATCH ? ${where}
      ORDER BY bm25(mem_fts) ASC, d.tier ASC
      LIMIT ?`;
    try {
      const rows = db.prepare(sql).all(matchExpr, ...params, Math.max(60, Math.min(200, limit * 20))) as Record<string, unknown>[];
      rows.forEach((r, i) => {
        if (seen.has(Number(r.id))) return;
        const body = String(r.body ?? "");
        const title = String(r.title ?? "");
        const hit: MemoryHit = {
          id: Number(r.id), tier: Number(r.tier), tier_label: TIER_LABEL[Number(r.tier)] ?? "",
          source: String(r.source), kind: String(r.kind), title,
          summary: String(r.summary ?? ""), snippet: makeSnippet(body, ftsTerms),
          score: Math.round(-Number(r.s) * 100) / 100, via: "fts",
          path: String(r.path), bytes: Number(r.bytes),
        };
        seen.add(hit.id);
        ranked.push({ hit, terms_hit: hitTerms(title, body, terms), order: i });
      });
    } catch {
      /* trigram 表达式边界情况 → 交由 LIKE 兜底 */
    }
  }

  // 2) LIKE 回退 / 长短语分段召回
  if (groups.length > 0 && ranked.length < limit * 4) {
    const likeCols = ["d.title", "d.summary", "d.body"];
    const conds: string[] = [];
    const lp: string[] = [];
    for (const g of groups) {
      const sub: string[] = [];
      for (const t of g) {
        const pat = `%${t.replace(/[%_]/g, "")}%`;
        sub.push(`(${likeCols.map((c) => `${c} LIKE ?`).join(" OR ")})`);
        lp.push(pat, pat, pat);
      }
      conds.push("(" + sub.join(" AND ") + ")");
    }
    const sql = `
      SELECT d.id, d.tier, d.source, d.kind, d.title, d.summary, d.body, d.path, d.bytes
      FROM mem_doc d
      WHERE ${conds.join(" AND ")} ${where}
      LIMIT 300`;
    let rows: Record<string, unknown>[] = [];
    try { rows = db.prepare(sql).all(...lp, ...params) as Record<string, unknown>[]; } catch { rows = []; }
    const scored: { hit: MemoryHit; w: number; th: number }[] = [];
    for (const r of rows) {
      if (seen.has(Number(r.id))) continue;
      const title = String(r.title ?? "");
      const summary = String(r.summary ?? "");
      const body = String(r.body ?? "");
      let w = 0;
      for (const t of likeTerms) {
        w += countOccurrence(title, t) * 6;
        w += countOccurrence(summary, t) * 3;
        w += Math.min(countOccurrence(body, t), 8) * 1;
      }
      if (w <= 0) continue;
      scored.push({
        hit: {
          id: Number(r.id), tier: Number(r.tier), tier_label: TIER_LABEL[Number(r.tier)] ?? "",
          source: String(r.source), kind: String(r.kind), title,
          summary: summary.slice(0, 200), snippet: makeSnippet(body, likeTerms),
          score: Math.round(w), via: "like", path: String(r.path), bytes: Number(r.bytes),
        },
        w,
        th: hitTerms(title, body, terms),
      });
    }
    scored.sort((a, b) => b.w - a.w);
    scored.forEach(({ hit, th }, i) => {
      seen.add(hit.id);
      ranked.push({ hit, terms_hit: th, order: i + 10000 });
    });
  }

  // 3) 汇总：先剔除「假命中」（trigram 会把 THM 配到 rhythm），再按命中词数 → 路径内排序
  let kept = ranked;
  const bestTh = ranked.reduce((mx, r) => Math.max(mx, r.terms_hit), 0);
  if (bestTh > 0) kept = ranked.filter((r) => r.terms_hit > 0);
  kept.sort((a, b) => b.terms_hit - a.terms_hit || a.order - b.order);
  return kept.slice(0, limit).map((r) => r.hit);
}

// ── 读取与目录 ──────────────────────────────────────────────────────────────

export interface MemoryDoc {
  id: number;
  tier: number;
  tier_label: string;
  source: string;
  kind: string;
  title: string;
  summary: string;
  keywords: string;
  path: string;
  bytes: number;
  created_at: string | null;
  updated_at: string | null;
  truncated: boolean;
  body: string;
}

export function memoryGet(db: DB, sel: { id?: number; path?: string }, maxBytes = 12000): MemoryDoc | null {
  const row = sel.id != null
    ? db.prepare("SELECT * FROM mem_doc WHERE id = ?").get(sel.id)
    : db.prepare("SELECT * FROM mem_doc WHERE path = ?").get(sel.path ?? "");
  if (!row) return null;
  const r = row as Record<string, unknown>;
  const storage = String(r.storage ?? 'disk');
  const path = String(r.path);
  const limit = Math.min(maxBytes, 60000);

  // disk 源：从磁盘 md 读全文（mem_doc.body 只是摘要快照）
  // inline 源：从 body 读（唯一存储）
  let body: string;
  if (storage === 'disk') {
    const fullPath = join(memoryDir(), path);
    try {
      body = readFileSync(fullPath, 'utf-8');
    } catch {
      // 磁盘文件不存在或读取失败，回退到 body 摘要
      body = String(r.body ?? "");
    }
  } else {
    body = String(r.body ?? "");
  }

  return {
    id: Number(r.id), tier: Number(r.tier), tier_label: TIER_LABEL[Number(r.tier)] ?? "",
    source: String(r.source), kind: String(r.kind), title: String(r.title),
    summary: String(r.summary ?? ""), keywords: String(r.keywords ?? ""),
    path, bytes: Number(r.bytes),
    created_at: (r.created_at as string | null) ?? null, updated_at: (r.updated_at as string | null) ?? null,
    truncated: body.length > limit,
    body: body.slice(0, limit),
  };
}

export interface MemoryMap {
  db_file: string;
  root: string;
  total_docs: number;
  total_bytes: number;
  last_reindex_at: string | null;
  tiers: {
    tier: number;
    label: string;
    docs: number;
    bytes: number;
    sources: { source: string; docs: number }[];
  }[];
  tier_titles: { id: number; tier: number; source: string; title: string }[];
  detail_tier: number | null;
  hint: string;
}

export function memoryMap(db: DB, opts: { tier?: number; limit?: number } = {}): MemoryMap {
  const totals = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(bytes),0) AS b FROM mem_doc").get() as { c: number; b: number };
  const out: MemoryMap = {
    db_file: memoryDbFile(),
    root: memoryDir(),
    total_docs: totals.c,
    total_bytes: totals.b,
    last_reindex_at: metaGet(db, "last_reindex_at") ?? null,
    tiers: [],
    tier_titles: [],
    detail_tier: null,
    hint: "",
  };
  const lim = Math.max(1, Math.min(200, Math.round(opts.limit ?? 60)));

  if (opts.tier !== undefined) {
    out.detail_tier = Number(opts.tier);
    const rows = db.prepare("SELECT id, tier, source, title FROM mem_doc WHERE tier = ? ORDER BY source, id LIMIT ?")
      .all(Number(opts.tier), lim) as { id: number; tier: number; source: string; title: string }[];
    out.tier_titles = rows;
    const c = db.prepare("SELECT COUNT(*) AS c FROM mem_doc WHERE tier = ?").get(Number(opts.tier)) as { c: number };
    out.tiers = [{ tier: Number(opts.tier), label: TIER_LABEL[Number(opts.tier)] ?? "", docs: c.c, bytes: 0, sources: [] }];
    out.hint = c.c > lim ? `该层共 ${c.c} 篇，仅列出前 ${lim} 篇；用 memory_search 按关键词取全文` : "用 memory_get(id) 取全文";
    return out;
  }

  const perTier = db.prepare(`
    SELECT tier, source, COUNT(*) AS c FROM mem_doc GROUP BY tier, source ORDER BY tier, source
  `).all() as { tier: number; source: string; c: number }[];
  const perTierBytes = db.prepare(`SELECT tier, COALESCE(SUM(bytes),0) AS b FROM mem_doc GROUP BY tier`).all() as { tier: number; b: number }[];
  const bmap = new Map<number, number>(perTierBytes.map((r) => [r.tier, r.b]));
  const groups = new Map<number, { label: string; docs: number; bytes: number; sources: { source: string; docs: number }[] }>();
  for (const r of perTier) {
    const g = groups.get(r.tier) ?? { label: TIER_LABEL[r.tier] ?? "", docs: 0, bytes: bmap.get(r.tier) ?? 0, sources: [] };
    g.docs += r.c;
    g.sources.push({ source: r.source, docs: r.c });
    groups.set(r.tier, g);
  }
  out.tiers = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([tier, g]) => ({
    tier, label: g.label, docs: g.docs, bytes: g.bytes, sources: g.sources,
  }));
  out.tier_titles = (db.prepare("SELECT id, tier, source, title FROM mem_doc WHERE tier = 0 ORDER BY id LIMIT ?").all(40) as {
    id: number; tier: number; source: string; title: string;
  }[]);
  out.hint = `tier 0/1 建议按话题先 memory_search；看某层目录用 memory_map(tier=N)`;
  return out;
}

export function memoryStats(db: DB): { docs: number; bytes: number; last_reindex_at: string | null; warnings: string } {
  const t = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(bytes),0) AS b FROM mem_doc").get() as { c: number; b: number };
  return { docs: t.c, bytes: t.b, last_reindex_at: metaGet(db, "last_reindex_at") ?? null, warnings: metaGet(db, "last_reindex_warnings") ?? "" };
}

/**
 * 打开库并保证「有数据可查」：库为空（首次/从未建过索引）时自动重建一次。
 * 仅做一次 COUNT(*)，非空库零开销；返回 stats 便于工具层提示「已自动建索引」。
 */
export function openReadyDb(): { db: DB; auto: boolean; stats: ReindexStats | null } {
  const db = openMemoryDb();
  const row = db.prepare("SELECT COUNT(*) AS c FROM mem_doc").get() as { c: number };
  if (row.c === 0) {
    const stats = scanAndIndex(db);
    return { db, auto: true, stats };
  }
  return { db, auto: false, stats: null };
}
