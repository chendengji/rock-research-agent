/**
 * pi-dream.ts — 记忆写入闭环：memory_add（暂存）+ memory_dream（会话蒸馏 → 分类沉淀 → 重建索引）
 *
 * 数据流（pi_memory.db 始终是源文件投影，dream 绝不直插 mem_doc）：
 *
 *   memory_add(text, kind, tags)
 *     → <root>/inbox/<YYYY-MM-DD>.md            当天临时暂存区，**不进索引**
 *        每条是一个 <!-- dream-entry begin ... --> 标记块，可被人工编辑/删除
 *
 *   memory_dream(date?, dry_run?, sessions?, inbox?)
 *     阶段1 抽取  递归扫 <ROCK_SESSION_DIR 或 ~/.pi/agent/sessions> 下所有 .jsonl，按本地日期过滤，
 *                  取 user/assistant 的 text 回合，剔除 toolResult / custom_message(RAG 注入) /
 *                  thinking / toolCall 参数 / system / <12 字寒暄
 *                  → <root>/.dream_tmp/<date>.md
 *     阶段2 蒸馏  子进程跑 support/scripts/dream-distill/distill.mjs 分批调 SenseNova LLM
 *                  （与 rag_rebuild.mjs 同一模式：可观测、不挂 pi、密钥只在子进程内）
 *                  → { items:[{kind,title,text,tags,confidence}], dropped, errors }
 *     阶段3 写入  inbox 条目（免 LLM，agent 已分类）+ 蒸馏条目 按 kind 路由写真实源目录：
 *                  user_fact → dream/user_facts/   tier 0  source=dream_fact
 *                  workflow  → dream/workflows/    tier 1  source=dream_workflow
 *                  note      → dream/notes/        tier 2  source=dream_note
 *     阶段4 落账  写 .dreams/dream-<stamp>.md 报告（索引为 tier2 dream；dry_run 报告写成
 *                  dream-dryrun-<stamp>.md，不被索引）→ scanAndIndex() 增量重建
 *                  → inbox/<date>.md 归档到 inbox/archive/（归档前再扫一遍密钥）
 *
 * 落账纪律：只有「会话蒸馏成功」且「inbox 无条目被搁置」才 markDreamed。零产出、蒸馏全批
 *   失败、或有 inbox 条目没写成时都不标记——否则一次 LLM 抽风就把当天会话永久锁进
 *   dreamed_dates，除非人工加 force 才能补救。date 参数非法直接中止，不静默落回今天。
 *
 * 为何 dream 产物品类目录独立于 workflows/ technotes/ user_facts/：
 *   后者是历史遗留、停止增长的手工目录；dream 产物集中在 dream/ 下，来源与 tier 一目了然，
 *   agent 也不会误把手写内容与蒸馏内容混在同一目录。
 *
 * MEMORY.md 与 user_facts/ 已废弃（2026-10-26）：不再作为 tier 0 来源扫描，
 *   原文件迁入 .retired/，内容已合并为 dream/user_facts/legacy-2026-07.md 保留可检索性。
 */

import { spawn } from "child_process";
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "fs";
import { basename, dirname, join, relative, sep } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { memoryDbFile, memoryDir, metaGet, metaSet, openMemoryDb, scanAndIndex } from "./pi-memory.ts";
// re-export 给 index.ts 消费：memory_add / memory_dream 的 execute 里
// await import("./lib/pi-dream.ts") 后要拿 memoryDir / openMemoryDb / memoryDbFile，
// 之前没 re-export 会让 index.ts 拿到 undefined，调用报 "memoryDir is not a function"。
export { memoryDbFile, memoryDir, openMemoryDb, scanAndIndex } from "./pi-memory.ts";

type DB = ReturnType<typeof openMemoryDb>;

// ── 品类路由 ────────────────────────────────────────────────────────────────

export type DreamKind = "user_fact" | "workflow" | "note";

export const DREAM_KINDS: DreamKind[] = ["user_fact", "workflow", "note"];

export const DREAM_KIND_ROUTE: Record<DreamKind, {
  dir: string; tier: 0 | 1 | 2; source: string; kind: string; label: string; hint: string;
}> = {
  user_fact: {
    dir: "user_facts", tier: 0, source: "dream_fact", kind: "fact",
    label: "用户事实与偏好",
    hint: "身份/单位/研究方向、长期偏好、稳定的环境与路径事实、工具与账号约定",
  },
  workflow: {
    dir: "workflows", tier: 1, source: "dream_workflow", kind: "workflow",
    label: "可重复工作流与绕坑",
    hint: "用户认可过的步骤顺序、绕坑方法、某类任务的标准做法、环境配置套路",
  },
  note: {
    dir: "notes", tier: 2, source: "dream_note", kind: "note",
    label: "技术结论与踩坑",
    hint: "技术点结论、失败根因与修复、版本/依赖/数据口径限制、实测数值",
  },
};

export function coerceKind(k: unknown): DreamKind {
  return k === "user_fact" || k === "workflow" || k === "note" ? k : "note";
}

// ── 路径（可覆盖，不写死用户目录）───────────────────────────────────────────

export function inboxDir(): string { return join(memoryDir(), "inbox"); }
export function inboxArchiveDir(): string { return join(inboxDir(), "archive"); }
export function dreamRoot(): string { return join(memoryDir(), "dream"); }
export function dreamTmpDir(): string { return join(memoryDir(), ".dream_tmp"); }
export function dreamReportDir(): string { return join(memoryDir(), ".dreams"); }

export function sessionDir(): string {
  const o = process.env.ROCK_SESSION_DIR?.trim();
  if (o) return o.replace(/[\\/]+$/, "");
  return join(homedir(), ".pi", "agent", "sessions");
}

function distillScript(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // lib/ → rock-research/ → extensions/ → 包根 rock-research-agent/
  return join(here, "..", "..", "..", "support", "scripts", "dream-distill", "distill.mjs");
}

// ── 文本工具 ────────────────────────────────────────────────────────────────

function pad2(n: number): string { return String(n).padStart(2, "0"); }

/** 本地时区日期 YYYY-MM-DD（会话时间戳是 UTC，必须转本地日期才能对上「今天」）。 */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function dateFromIso(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : localDate(d);
}

function dateOk(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = String(s).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

function stamp(d: Date = new Date()): string {
  return `${localDate(d).replace(/-/g, "")}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** FNV-1a 短哈希：用于 dream 产物文件名去重与幂等。 */
function hash6(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36).padStart(6, "0").slice(0, 6);
}

/** 标题 → 文件名片段（保留中日韩与字母数字，其余转连字符）。 */
function slug(s: string, max = 36): string {
  const t = s.toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, "-")
    .replace(/[\s_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, max);
  return t || "item";
}

function cleanRel(p: string): string { return relative(memoryDir(), p).split(sep).join("/"); }

function readDir(dir: string): import("fs").Dirent[] {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function readTextSafe(file: string): string {
  try { return readFileSync(file, "utf8"); } catch { return ""; }
}

/** LLM 常把品类名/流程名当标签输出，这些标签没有检索价值，直接剔除。 */
const TAG_NOISE = new Set([
  "user_fact", "workflow", "note", "fact", "dream", "kind", "tags", "title",
  "memory", "agent", "llm", "item", "json",
  "记忆", "蒸馏", "工作流", "用户事实", "技术笔记", "结论", "标签", "品类", "分类",
]);

function cleanTags(tags: unknown, max = 8): string[] {
  if (!Array.isArray(tags)) return [];
  const out: string[] = [];
  for (const t of tags) {
    const s = String(t ?? "").trim().replace(/^#+/, "").toLowerCase().replace(/\s+/g, " ");
    if (!s || s.length > 40 || TAG_NOISE.has(s) || out.includes(s)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

// ── 阶段 0：memory_add ──────────────────────────────────────────────────────

const INBOX_BEGIN = "<!-- dream-entry begin";
const INBOX_END = "<!-- dream-entry end -->";

export interface MemoryAddInput {
  text: string;
  kind?: DreamKind | string;
  title?: string;
  tags?: string[];
  date?: string;
  reason?: string;
}

export interface MemoryAddResult {
  ok: boolean;
  path: string;
  rel: string;
  date: string;
  at: string;
  kind: DreamKind;
  title: string;
  tags: string[];
  bytes: number;
  entries_in_file: number;
  pending: InboxStatus[];
  /** 入口清扫掉的疑似密钥处数（inbox 会原样落盘，这里必须扫） */
  scrubbed: number;
  /** 同日 inbox 已有相同正文 → 未重复追加 */
  duplicate: boolean;
  appended: boolean;
  note: string;
}

/** 把一条 agent 主动记忆追加到「当天的临时 md」。不进索引，等 memory_dream 沉淀。 */
export function memoryAdd(input: MemoryAddInput): MemoryAddResult {
  const date = dateOk(input.date) ?? localDate();
  const kind = coerceKind(input.kind);
  const tags = cleanTags(input.tags);
  const at = new Date().toISOString();

  // 入口即清扫：inbox 是密钥最易漏到磁盘的地方——agent 手写、原样落盘、可能躺几天才 dream。
  // writeDreamItems 里那一遍扫不到这里的明文。title 也要单独扫，否则密钥能只出现在标题里。
  const body = scrubSecrets(String(input.text ?? "").replace(/\r\n/g, "\n").trim());
  const titleIn = String(input.title ?? "");
  const title = (scrubSecrets(titleIn).text.replace(/\s+/g, " ").trim().slice(0, 80))
    || body.text.slice(0, 60).replace(/\s+/g, " ").trim();
  const scrubbed = body.scrubbed + scrubSecrets(titleIn).scrubbed;
  const text = body.text;

  const dir = inboxDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${date}.md`);

  // 同日同一条不重复追加：inbox 是纯 append，重复暂存只会浪费 dream 的蒸馏名额
  // （dream 侧的标题去重能兜住成稿，但 inbox 里会堆出肉眼可见的重复块）
  if (existsSync(file)) {
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    if (parseInboxFile(file).some(e => norm(e.text) === norm(text))) {
      return {
        ok: true, path: file, rel: cleanRel(file), date, at, kind, title, tags,
        bytes: 0, entries_in_file: parseInboxFile(file).length, pending: listInbox(),
        scrubbed, duplicate: true, appended: false,
        note: `同日 inbox 已有相同条目（${cleanRel(file)}），未重复追加。要改文案请直接编辑该文件里对应的 dream-entry 块。`,
      };
    }
  }

  if (!existsSync(file)) {
    writeFileSync(file, [
      `# Inbox ${date}`,
      "",
      "> memory_add 暂存区。memory_dream 会把这里的内容与当天会话记录一起蒸馏、分类写入 dream/ 目录并重建索引，",
      "> 随后本文件归档到 inbox/archive/。inbox/ 不参与索引，写在这里的内容尚不可被 memory_search 检索。",
      "",
      "",
    ].join("\n"), "utf8");
  }

  const head: string[] = [INBOX_BEGIN, `at: ${at}`, `kind: ${kind}`, `title: ${title}`, `tags: ${tags.join(",")}`];
  if (input.reason) head.push(`reason: ${String(input.reason).replace(/\s+/g, " ").slice(0, 200)}`);
  head.push("-->");
  const block = [...head, "", text, "", INBOX_END, ""].join("\n");
  appendFileSync(file, block + "\n", "utf8");

  const entries = parseInboxFile(file);
  const pending = listInbox();
  return {
    ok: true, path: file, rel: cleanRel(file), date, at, kind, title, tags,
    bytes: Buffer.byteLength(text),
    entries_in_file: entries.length,
    pending,
    scrubbed, duplicate: false, appended: true,
    note: `已暂存 ${cleanRel(file)}（该日共 ${entries.length} 条）。尚未入库——等 memory_dream 沉淀后才可被 memory_search 检索。${scrubbed ? ` 已清扫 ${scrubbed} 处疑似密钥（掩码为 ****，未写入取值）。` : ""}`,
  };
}

export interface InboxEntry {
  date: string;
  at: string;
  kind: DreamKind;
  title: string;
  tags: string[];
  reason: string;
  text: string;
  bytes: number;
}

/** 解析 inbox md 里的所有 dream-entry 块（人写的正文不受影响，只认标记块）。 */
export function parseInboxFile(file: string): InboxEntry[] {
  const raw = readTextSafe(file);
  if (!raw) return [];
  const out: InboxEntry[] = [];
  const parts = raw.split(INBOX_BEGIN);
  for (let i = 1; i < parts.length; i++) {
    const rest = parts[i];
    const end = rest.indexOf(INBOX_END);
    if (end < 0) continue;
    const inner = rest.slice(0, end);
    // 头块以独占一行的 --> 结束（begin 标记后紧跟换行，不能靠第一个 \n 切分）
    const m = /^([\s\S]*?)\n-->\r?\n([\s\S]*)$/.exec(inner);
    if (!m) continue;
    const headText = m[1];
    const body = m[2].trim();
    if (!body) continue;
    const head: Record<string, string> = {};
    for (const line of headText.split(/\r?\n/)) {
      const m = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
      if (m) head[m[1]] = m[2].trim();
    }
    out.push({
      date: head.date || "",
      at: head.at || "",
      kind: coerceKind(head.kind),
      title: head.title || body.slice(0, 60).replace(/\s+/g, " ").trim(),
      tags: cleanTags((head.tags || "").split(",")),
      reason: head.reason || "",
      text: body,
      bytes: Buffer.byteLength(body),
    });
  }
  return out;
}

export interface InboxStatus { date: string; path: string; rel: string; entries: number; bytes: number }

/** 列出 inbox/ 下所有待沉淀日期文件（不含 archive/）。 */
export function listInbox(): InboxStatus[] {
  const out: InboxStatus[] = [];
  for (const e of readDir(inboxDir())) {
    if (!e.isFile()) continue;
    const m = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(e.name);
    if (!m) continue;
    const p = join(inboxDir(), m[1] + ".md");
    let bytes = 0;
    try { bytes = statSync(p).size; } catch { /* ignore */ }
    out.push({ date: m[1], path: p, rel: cleanRel(p), entries: parseInboxFile(p).length, bytes });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 归档已处理的 inbox 文件（可恢复：不是删除，是移入 inbox/archive/）。 */
/**
 * 归档已处理的 inbox 文件（可恢复：不是删除，是移入 inbox/archive/）。
 *
 * 归档前再扫一遍密钥：inbox 允许人工编辑，手写进去的密钥块会随归档永久驻留磁盘，
 * 而 archive/ 不参与索引，等于一个无人会去看的明文副本。
 */
export function archiveInbox(dates: string[]): { moved: string[]; skipped: string[]; scrubbed: number } {
  const moved: string[] = [];
  const skipped: string[] = [];
  let scrubbed = 0;
  mkdirSync(inboxArchiveDir(), { recursive: true });
  for (const d of [...new Set(dates)]) {
    const f = join(inboxDir(), `${d}.md`);
    if (!existsSync(f)) { skipped.push(`inbox/${d}.md（不存在）`); continue; }
    if (parseInboxFile(f).length === 0) { skipped.push(`inbox/${d}.md（空，不归档）`); continue; }
    let dest = join(inboxArchiveDir(), `${d}.md`);
    if (existsSync(dest)) {
      try { dest = join(inboxArchiveDir(), `${d}-${hash6(d + statSync(f).mtimeMs)}.md`); } catch { continue; }
    }
    try {
      const raw = readTextSafe(f);
      const cleaned = scrubSecrets(raw).text;
      if (cleaned !== raw) { writeFileSync(f, cleaned, "utf8"); scrubbed++; }
      renameSync(f, dest); moved.push(cleanRel(dest));
    }
    catch (e) { skipped.push(`inbox/${d}.md（${(e as Error).message}）`); }
  }
  return { moved, skipped, scrubbed };
}

// ── 阶段 1：会话抽取 ────────────────────────────────────────────────────────

export interface SessionExtract {
  ok: boolean;
  date: string;
  session_dir: string;
  sessions: number;
  turns: number;
  user_turns: number;
  assistant_turns: number;
  chars: number;
  raw_path: string;
  raw_rel: string;
  files: string[];
  warnings: string[];
}

const USER_MIN_CHARS = 12;      // 短于这个的 user 回合视为寒暄，不进蒸馏
const TURN_MAX_CHARS = 3000;    // 单回合上限，防单条灌爆 LLM

/** 递归扫 sessions 下所有 .jsonl，抽出指定本地日期的 user/assistant 文本回合。 */
export function extractSessions(opts: { date?: string } = {}): SessionExtract {
  const date = dateOk(opts.date) ?? localDate();
  const root = sessionDir();
  const warnings: string[] = [];
  const files: string[] = [];
  const turns: { who: "user" | "assistant"; at: string; cwd: string; text: string }[] = [];
  let sessions = 0, userTurns = 0, assistantTurns = 0;

  for (const d of readDir(root).filter(e => e.isDirectory())) {
    const dir = join(root, d.name);
    for (const e of readDir(dir).filter(e => e.isFile() && e.name.toLowerCase().endsWith(".jsonl"))) {
      const p = join(dir, e.name);
      const raw = readTextSafe(p);
      if (!raw) continue;
      let cwd = "";
      let got = 0;
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let o: any;
        try { o = JSON.parse(line); } catch { continue; }
        if (!o || typeof o !== "object") continue;
        if (o.type === "session") { cwd = String(o.cwd ?? ""); continue; }
        if (o.type !== "message" || !o.message) continue;
        const m = o.message;
        if (m.role !== "user" && m.role !== "assistant") continue;
        const at = String(o.timestamp ?? m.timestamp ?? "");
        if (dateFromIso(at) !== date) continue;
        const parts = Array.isArray(m.content) ? m.content : [];
        const texts = parts.filter(c => c && c.type === "text" && typeof c.text === "string").map(c => c.text);
        let body = texts.join("\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
        if (!body) continue;
        if (m.role === "user" && body.length < USER_MIN_CHARS) continue;
        if (body.length > TURN_MAX_CHARS) body = body.slice(0, TURN_MAX_CHARS) + "\n\n[... 单回合超长，已截断 ...]";
        turns.push({ who: m.role, at: at.slice(0, 19), cwd, text: body });
        got++;
        if (m.role === "user") userTurns++; else assistantTurns++;
      }
      if (got > 0) { sessions++; files.push(e.name); }
    }
  }

  const chars = turns.reduce((n, t) => n + t.text.length, 0);
  const body: string[] = [];
  let curCwd = "";
  for (const t of turns) {
    if (t.cwd !== curCwd) {
      body.push("", `## session | cwd=${t.cwd || "(未知)"}`, "");
      curCwd = t.cwd;
    }
    body.push(`### [${t.who}] ${t.at}`, "", t.text, "");
  }
  const md = [
    `# Dream raw extract ${date}`,
    "",
    `- sessions: ${sessions}`,
    `- turns: ${turns.length}（user ${userTurns} / assistant ${assistantTurns}）`,
    `- chars: ${chars}`,
    `- 已剔除: toolResult / custom_message(RAG 注入) / thinking / toolCall 参数 / system / <${USER_MIN_CHARS}字寒暄`,
    "- 用途: 仅作 dream 蒸馏输入，不参与记忆索引",
    "",
    ...body,
  ].join("\n");

  const tmpDir = dreamTmpDir();
  mkdirSync(tmpDir, { recursive: true });
  const outPath = join(tmpDir, `${date}.md`);
  if (turns.length > 0) writeFileSync(outPath, md + "\n", "utf8");
  else warnings.push(`${date} 无可蒸馏回合（当天无会话，或当天会话全为工具输出/寒暄）`);

  return {
    ok: turns.length > 0, date, session_dir: root, sessions, turns: turns.length,
    user_turns: userTurns, assistant_turns: assistantTurns, chars,
    raw_path: turns.length > 0 ? outPath : "", raw_rel: turns.length > 0 ? cleanRel(outPath) : "",
    files, warnings,
  };
}

// ── 阶段 2：LLM 蒸馏（子进程）──────────────────────────────────────────────

export interface RawDreamItem {
  kind: string; title: string; text: string; tags: string[]; confidence: number; batch: number;
}

export interface DistillResult {
  ok: boolean;
  model: string;
  batches: number;
  batches_failed: number;
  elapsed_ms: number;
  items: RawDreamItem[];
  dropped: { summary: string; reason: string; batch: number }[];
  errors: { batch: number; error: string }[];
}

const DISTILL_TIMEOUT_MS = 900_000;   // 15 分钟硬上限

/** 子进程跑 distill.mjs 分批调 SenseNova LLM 蒸馏。失败返回 ok=false + errors，不抛。 */
export function distillRaw(rawPath: string, opts: { model?: string } = {}): Promise<DistillResult> {
  const model = opts.model || "sensenova-6.8-flash-lite";
  const empty = (error: string): DistillResult => ({
    ok: false, model, batches: 0, batches_failed: 0, elapsed_ms: 0, items: [], dropped: [], errors: [{ batch: 0, error }],
  });
  return new Promise((resolve) => {
    const script = distillScript();
    if (!existsSync(script)) return resolve(empty(`蒸馏 runner 不存在：${script}`));
    if (!existsSync(rawPath)) return resolve(empty(`raw extract 不存在：${rawPath}`));

    const outPath = join(dreamTmpDir(), `${stamp()}-distill.json`);
    const child = spawn("node", [script, rawPath, "--out", outPath, "--model", model, "--concurrency", "2"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve(empty(`蒸馏超时（>${DISTILL_TIMEOUT_MS / 1000}s）已终止子进程`));
    }, DISTILL_TIMEOUT_MS);

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => {
      if (settled) return; settled = true; clearTimeout(guard);
      resolve(empty(`spawn node 失败：${e.message}`));
    });
    child.on("close", () => {
      if (settled) return; settled = true; clearTimeout(guard);
      let parsed: any = null;
      try { parsed = JSON.parse(readTextSafe(outPath)); } catch { /* ignore */ }
      if (!parsed || typeof parsed !== "object") {
        return resolve(empty(`runner 未产出结果 JSON（exit 后无 ${outPath}；stdout: ${stdout.slice(0, 160)}；stderr: ${stderr.slice(0, 160)}）`));
      }
      const items: RawDreamItem[] = (Array.isArray(parsed.items) ? parsed.items : [])
        .map((it: any) => ({
          kind: String(it.kind ?? ""), title: String(it.title ?? ""), text: String(it.text ?? ""),
          tags: Array.isArray(it.tags) ? cleanTags(it.tags) : [],
          confidence: Number(it.confidence ?? 0), batch: Number(it.batch ?? 0),
        }))
        .filter((it) => it.text.trim().length >= 20);
      const errors = Array.isArray(parsed.errors) && parsed.errors.length
        ? parsed.errors
        : (parsed.error ? [{ batch: 0, error: String(parsed.error) }] : []);
      resolve({
        ok: !!parsed.ok, model: String(parsed.model ?? model),
        batches: Number(parsed.batches ?? 0), batches_failed: Number(parsed.batches_failed ?? 0),
        elapsed_ms: Number(parsed.elapsed_ms ?? 0), items,
        dropped: Array.isArray(parsed.dropped) ? parsed.dropped : [],
        errors,
      });
    });
  });
}

// ── 阶段 3：写入 dream/ 源目录 ──────────────────────────────────────────────

export interface PendingItem {
  date: string;
  kind: DreamKind;
  title: string;
  text: string;
  tags: string[];
  confidence: number;
  origin: "inbox" | "session";
}

export interface WrittenItem {
  kind: DreamKind;
  title: string;
  /** 条目归属日期（用于判断哪些 inbox 日期真的被消费掉了） */
  date: string;
  target: string;
  target_abs: string;
  bytes: number;
}

export interface WriteSkip {
  title: string;
  kind: DreamKind;
  date: string;
  target: string;
  reason: string;
  /** 跳过原因分类：too_short 的内容不该被归档消费（要留在 inbox 让 agent 看到） */
  disposition: "too_short" | "duplicate_title" | "near_duplicate";
}

export interface WriteResult {
  written: WrittenItem[];
  skipped: WriteSkip[];
}

/** 正文过短 → 不值得成篇。 */
const MIN_ITEM_CHARS = 20;
/**
 * 近似重复阈值（token 级 Jaccard）。
 * 实测口径：同一句子的改写漂移得分 0.52~0.87，真正不同的条目最高 0.41 ——
 * 0.5 正好落在两者之间。
 *
 * 边界要说清楚：「同一个事实被完全不同地重述」只得分 0.18 左右，与无关条目混在同一
 * 区间，**任何 token 级阈值都分不开**。这类近重复靠「一天只 dream 一次」的日期级幂等
 * （dreamedDates / markDreamed）兜住，不靠相似度。
 */
const DEDUP_SIM_THRESHOLD = 0.5;

/** 正文 → 特征集：英文/路径 token + 中文 unigram/bigram。用于近似重复检测。 */
function textGrams(text: string): Set<string> {
  const s = String(text).toLowerCase();
  const grams = new Set<string>();
  for (const m of s.matchAll(/[a-z0-9][a-z0-9_./\\:-]{1,}/g)) grams.add(m[0]);
  const cjk = s.replace(/[^\u3400-\u9fff\uf900-\ufaff]/g, "");
  for (let i = 0; i < cjk.length; i++) {
    grams.add(cjk[i]);
    if (i + 1 < cjk.length) grams.add(cjk[i] + cjk[i + 1]);
  }
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const g of small) if (big.has(g)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 只取 md 的散文正文：去掉 frontmatter、`#` 标题行、开头的 `> ` 引用块（沉淀元信息）。
 * 相似度比较必须用它——若带着标题与引用行比，两条同主题条目的公共元数据会被算成"不同"，
 * 实测会把 0.523 的重复对稀释到 0.307。
 */
function proseOnly(md: string): string {
  const t = md.replace(/^\uFEFF/, "");
  const end = t.startsWith("---") ? t.indexOf("\n---", 3) : -1;
  if (end < 0) return t;
  const lines = t.slice(end + 4).split("\n");
  let i = 0;
  const skip = (pred: (l: string) => boolean) => { while (i < lines.length && pred(lines[i])) i++; };
  skip(l => l.trim() === "");
  skip(l => /^#{1,6}\s/.test(l));
  skip(l => l.trim() === "");
  skip(l => /^> /.test(l));
  skip(l => l.trim() === "");
  return lines.slice(i).join("\n").trim();
}

/** 渲染单个 dream 产物 md。干跑与实跑共用同一函数——否则两边报出的 bytes 不可比。 */
function renderItemMd(it: PendingItem, opts: { model: string; at: string }, safeTitle: string, safeText: string, scrubbed: number): string {
  const tags = cleanTags(it.tags);
  const conf = Math.round(Math.max(0, Math.min(1, Number(it.confidence) || 0)) * 100) / 100;
  const desc = safeText.replace(/\s+/g, " ").trim().slice(0, 260);
  // 注意：不能用 .filter(l => l !== "") 拼 md —— 那会把有意的空行（标题与引用之间、
  // 引用与正文之间）一起删掉，导致「# 标题> dream 沉淀于…\n正文」挤在一起。
  const fm = ["---", `name: ${safeTitle}`, `description: ${desc}`];
  if (tags.length) fm.push(`tags: ${tags.join(", ")}`);
  fm.push(`dream_date: ${it.date}`, `dream_kind: ${it.kind}`, `dream_origin: ${it.origin}`,
    `dream_confidence: ${conf}`, "---");
  const body = [
    "",
    `# ${safeTitle}`,
    "",
    `> dream 沉淀于 ${opts.at.slice(0, 10)} · 来源 ${it.origin === "inbox" ? "agent 主动 memory_add" : "会话记录 LLM 蒸馏"}${opts.model && it.origin === "session" ? ` · 模型 ${opts.model}` : ""} · confidence ${conf}${scrubbed ? ` · 已清扫 ${scrubbed} 处疑似密钥` : ""}`,
    "",
    safeText,
    "",
  ].join("\n");
  return fm.join("\n") + "\n" + body;
}

/** 按 kind 把条目写成分品类源目录下的 md（每条目一个文件，检索粒度最细）。幂等。 */
export function writeDreamItems(items: PendingItem[], opts: {
  model: string; at: string; dryRun?: boolean;
}): WriteResult {
  const written: WrittenItem[] = [];
  const skipped: WriteSkip[] = [];
  const dryRun = !!opts.dryRun;

  for (const it of items) {
    const route = DREAM_KIND_ROUTE[it.kind];
    const dir = join(dreamRoot(), route.dir);
    const text = String(it.text ?? "").replace(/\r\n/g, "\n").trim();
    const title = (String(it.title ?? "").replace(/\s+/g, " ").trim().slice(0, 80))
      || text.slice(0, 60).replace(/\s+/g, " ").trim();
    if (text.length < MIN_ITEM_CHARS) {
      skipped.push({ title, kind: it.kind, date: it.date, target: "",
        reason: `正文过短（<${MIN_ITEM_CHARS} 字符），不值得单独成篇`, disposition: "too_short" });
      continue;
    }
    // 兜底清扫密钥：distill 侧已扫过一遍，这里覆盖 inbox（agent 手写）通道
    const _sc = scrubSecrets(text);
    const scrubbed = _sc.scrubbed + scrubSecrets(title).scrubbed;
    const safeText = _sc.text;
    const safeTitle = scrubSecrets(title).text;
    const base = `${it.date}-${slug(safeTitle)}`;
    const file = join(dir, `${base}-${hash6(safeText)}.md`);

    // 幂等第一层：同日同 kind 下已有同标题条目（措辞完全一致的重跑）
    const siblings = readDir(dir).map(e => e.name)
      .filter(n => n.toLowerCase().startsWith(it.date + "-") && n.toLowerCase().endsWith(".md"));
    const sameTitle = siblings.filter(n => n.toLowerCase().startsWith(base + "-"));
    if (sameTitle.length > 0) {
      skipped.push({ title, kind: it.kind, date: it.date, target: cleanRel(join(dir, sameTitle[0])),
        reason: "同日已有同标题条目（重复运行的幂等保护）", disposition: "duplicate_title" });
      continue;
    }

    // 幂等第二层：正文近似重复（LLM 重跑措辞漂移——标题变了但说的是同一件事）
    const grams = textGrams(text);
    let dupTarget = "";
    let dupSim = 0;
    for (const n of siblings) {
      if (sameTitle.includes(n)) continue;
      const sim = jaccard(grams, textGrams(proseOnly(readTextSafe(join(dir, n)))));
      if (sim > dupSim) { dupSim = sim; dupTarget = n; }
    }
    if (dupTarget && dupSim >= DEDUP_SIM_THRESHOLD) {
      skipped.push({ title, kind: it.kind, date: it.date, target: cleanRel(join(dir, dupTarget)),
        reason: `正文与已有条目近似（相似度 ${dupSim.toFixed(2)} ≥ ${DEDUP_SIM_THRESHOLD}），判定为重复运行产物`,
        disposition: "near_duplicate" });
      continue;
    }

    const md = renderItemMd(it, { model: opts.model, at: opts.at }, safeTitle, safeText, scrubbed);
    const rec: WrittenItem = { kind: it.kind, title: safeTitle, date: it.date,
      target: cleanRel(file), target_abs: file, bytes: Buffer.byteLength(md) };
    if (dryRun) { written.push(rec); continue; }

    mkdirSync(dir, { recursive: true });
    writeFileSync(file, md, "utf8");
    written.push(rec);
  }
  return { written, skipped };
}

/**
 * 密钥清扫（兜底）。distill.mjs 侧已做同样处理，这里再拦一遍以覆盖 memory_add 通道
 * —— agent 可能在 inbox 里写出密钥值，而 inbox 会原样沉淀进记忆库。
 * 只保留「变量名指向」，绝不保留取值。返回 { text, scrubbed }。
 */
/**
 * 掩码一律写成 ****，**不保留 sk- / ghp_ / glpat- 这类前缀**。
 * 原因：dream 产物的文件名和 frontmatter title 都从清扫后的文本派生，
 * title 又会被索引进 FTS——掩码若留前缀，密钥指纹就跟着进了可检索索引，
 * 等于违反「只写前缀也算泄漏」的口径。
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  // 每个模式都同时认「真实值」和「已被上游掩成前缀+星号」的形态——distill.mjs 侧会把密钥
  // 掩成 sk-**** / ghp_**** / AKIA**** 再返回，若这里只认真值，前缀就会原样落到 dream 产物里。
  [/sk-(?:[A-Za-z0-9_\-]{6,}|\*{2,})/g, "****"],
  [/AKIA(?:[0-9A-Z]{6,}|\*{2,})/g, "****"],
  [/gh[pousr]_(?:[A-Za-z0-9]{10,}|\*{2,})/g, "****"],
  [/github_pat_(?:[A-Za-z0-9_]{10,}|\*{2,})/g, "****"],
  [/glpat-(?:[A-Za-z0-9_\-]{6,}|\*{2,})/g, "****"],
  [/xox[bpars]-(?:[A-Za-z0-9-]{6,}|\*{2,})/g, "****"],
  // Bearer 是协议关键词不是密钥前缀，留着便于读上下文
  [/Bearer\s+[A-Za-z0-9._\-]{10,}/gi, "Bearer ****"],
  [/\b[A-Za-z0-9+\/]{40,}={0,2}\b/g, "****"],
];
/** password=xxx / api_key: xxx / ?token=xxx —— 保留键名，只抹取值。 */
const KEY_VALUE_RE = /\b([a-zA-Z_]*(?:key|token|secret|password|passwd|pwd))\b([=:])(\s*)([^&\s,，。；;"'）)]{6,})/gi;

export function scrubSecrets(text: string): { text: string; scrubbed: number } {
  let s = String(text ?? "");
  let scrubbed = 0;
  for (const [re, sub] of SECRET_PATTERNS) {
    const before = s;
    s = s.replace(re, sub);
    if (s !== before) scrubbed++;
  }
  const before2 = s;
  s = s.replace(KEY_VALUE_RE, (_m, k, sep, sp) => `${k}${sep}${sp}****`);
  if (s !== before2) scrubbed++;
  return { text: s, scrubbed };
}

/** 读 md frontmatter 的某个字段（不存在返回 undefined）。 */
function frontmatterField(md: string, key: string): string | undefined {
  const t = md.replace(/^\uFEFF/, "");
  if (!t.startsWith("---")) return undefined;
  const end = t.indexOf("\n---", 3);
  if (end < 0) return undefined;
  const m = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(t.slice(0, end));
  return m ? m[1].trim() : undefined;
}

export interface DedupeEntry { removed: string; kept: string; sim: number; title: string }

export interface DedupeResult {
  dry_run: boolean;
  scanned: number;
  clusters: number;
  removed: DedupeEntry[];
  moved_to: string;
  note: string;
}

/**
 * dream 产物近似去重（维护工具，非每日流程）。
 *
 * 历史 LLM 重跑会在同一天同品类下留下措辞不同的近重复条目（"API Key 配置" / "API Key 配置约定"），
 * 标题去重抓不住这类。这里按正文 Jaccard 相似度聚簇，每簇保留 confidence 最高
 * （同分取正文最长，再同分取文件名最小）的一条，其余移入
 * `.retired/dream-dedup-<时间戳>/<kind>/` —— 移入而非删除，可恢复。
 *
 * 调用后仍需再跑一次 memory_reindex，库里才会同步移除这些条目。
 */
export function dedupeDreamItems(opts: { date?: string; dryRun?: boolean; threshold?: number } = {}): DedupeResult {
  const threshold = opts.threshold ?? DEDUP_SIM_THRESHOLD;
  const dryRun = !!opts.dryRun;
  const date = dateOk(opts.date);
  const prefix = date ? date + "-" : "";
  const stashRoot = join(memoryDir(), ".retired", `dream-dedup-${stamp()}`);

  const removed: DedupeEntry[] = [];
  let scanned = 0;
  let clusters = 0;

  for (const kind of DREAM_KINDS) {
    const dir = join(dreamRoot(), DREAM_KIND_ROUTE[kind].dir);
    const files = readDir(dir)
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map(e => join(dir, e.name))
      .filter(p => !prefix || basename(p).toLowerCase().startsWith(prefix));
    if (files.length < 2) continue;
    scanned += files.length;

    const bodies = files.map(p => proseOnly(readTextSafe(p)));
    const grams = bodies.map(textGrams);

    // union-find：相似度 ≥ threshold 的两条归为一簇（传递闭包）
    const parent = files.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        if (jaccard(grams[i], grams[j]) >= threshold) {
          const a = find(i), b = find(j);
          if (a !== b) parent[b] = a;
        }
      }
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < files.length; i++) {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(i);
    }

    for (const idx of groups.values()) {
      if (idx.length < 2) continue;
      clusters++;
      // 保留：confidence 高 → 正文长 → 文件名小
      idx.sort((a, b) => {
        const ca = Number(frontmatterField(readTextSafe(files[a]), "dream_confidence") || 0);
        const cb = Number(frontmatterField(readTextSafe(files[b]), "dream_confidence") || 0);
        if (ca !== cb) return cb - ca;
        if (bodies[a].length !== bodies[b].length) return bodies[b].length - bodies[a].length;
        return basename(files[a]).localeCompare(basename(files[b]));
      });
      const keeper = idx[0];
      for (let k = 1; k < idx.length; k++) {
        const victim = idx[k];
        removed.push({
          removed: cleanRel(files[victim]),
          kept: cleanRel(files[keeper]),
          sim: Math.round(jaccard(grams[victim], grams[keeper]) * 100) / 100,
          title: frontmatterField(readTextSafe(files[victim]), "name") || basename(files[victim]),
        });
        if (!dryRun) {
          const dest = join(stashRoot, DREAM_KIND_ROUTE[kind].dir, basename(files[victim]));
          mkdirSync(dirname(dest), { recursive: true });
          renameSync(files[victim], dest);
        }
      }
    }
  }

  return {
    dry_run: dryRun, scanned, clusters, removed,
    moved_to: dryRun ? "" : cleanRel(stashRoot),
    note: dryRun
      ? `dry_run：${removed.length} 条判定为近似重复（${clusters} 个重复簇），未移动任何文件。去掉 dryRun 重跑以实际归档。`
      : `已把 ${removed.length} 条近似重复制入 .retired/（可恢复，未删除）。请再跑一次 memory_reindex 让库里同步移除。`,
  };
}

// ── 阶段 4：报告与状态 ──────────────────────────────────────────────────────

/**
 * 写 dream 运行报告到 .dreams/（该目录被索引为 tier 2 source=dream，运行历史本身可检索）。
 * 干跑报告单独写成 dream-dryrun-<时间>.md——索引侧的正则只认 dream-<yyyymmdd>-<hhmmss>.md，
 * 所以「跑一次 dry_run 就往记忆库埋一条运行计划」这件事不会发生。
 */
export function writeDreamReport(lines: string[], opts: { dryRun?: boolean } = {}): string {
  const dir = dreamReportDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${opts.dryRun ? "dream-dryrun-" : "dream-"}${stamp()}.md`);
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

/**
 * 清理 .dream_tmp 里过期的蒸馏流水（*-distill.json）。
 * 该目录过去从不清理，每次蒸馏都会留一个 JSON 累积下去。raw extract（<date>.md）保留：
 * 它是重跑/复现蒸馏的输入，且日期级幂等后一天只会有一份。
 */
export function pruneDreamTmp(maxAgeMs = 48 * 3600000): string[] {
  const removed: string[] = [];
  const now = Date.now();
  for (const e of readDir(dreamTmpDir())) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith("-distill.json")) continue;
    const p = join(dreamTmpDir(), e.name);
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) { unlinkSync(p); removed.push(cleanRel(p)); }
    } catch { /* 并发删不掉就跳过 */ }
  }
  return removed;
}

export interface DreamStatus {
  last_dream_at: string | null;
  last_dream_date: string | null;
  last_dream_items: number | null;
  hours_since: number | null;
  pending: InboxStatus[];
  pending_entries: number;
  /** 已沉淀但 inbox 仍有积压的日期——只能 force=true 重跑才能处理，普通 dream 会拒绝 */
  pending_already_dreamed: string[];
  due: boolean;
}

/** dream 运行状态 + 待沉淀积压（供 memory_add / memory_dream 的软提醒）。 */
export function dreamStatus(db?: DB): DreamStatus {
  const d = db ?? openMemoryDb();
  const last = metaGet(d, "last_dream_at") ?? null;
  const hoursSince = last ? Math.max(0, (Date.now() - Date.parse(last)) / 3600000) : null;
  const pending = listInbox();
  const pendingEntries = pending.reduce((n, p) => n + p.entries, 0);
  // 软提醒阈值：跨天 或 积压 ≥3 条
  const oldest = pending.length ? pending[0].date : "";
  const stale = !!oldest && oldest < localDate();
  const dreamed = dreamedDates(d);
  const pendingAlready = pending.map(p => p.date).filter(x => dreamed.includes(x));
  const itemsRaw = metaGet(d, "last_dream_items");
  const items = itemsRaw != null && Number.isFinite(Number(itemsRaw)) ? Number(itemsRaw) : null;
  return {
    last_dream_at: last,
    last_dream_date: metaGet(d, "last_dream_date") ?? null,
    last_dream_items: items,
    hours_since: hoursSince == null ? null : Math.round(hoursSince * 10) / 10,
    pending, pending_entries: pendingEntries,
    pending_already_dreamed: pendingAlready,
    due: stale || pendingEntries >= 3,
  };
}

export function pendingHint(st: DreamStatus): string {
  if (st.pending_entries === 0) return "";
  const dates = st.pending.map(p => p.date).join(", ");
  const tail = st.hours_since == null ? "此前从未运行过 dream" : `距上次 dream ${st.hours_since} 小时`;
  // 不说"建议调 memory_dream"就够了：若积压日期已沉淀过，普通 dream 会拒绝，agent 会卡在
  // 「提示 dream → already_dreamed」的循环里。必须显式给出 force=true 这条出路。
  const stuck = st.pending_already_dreamed.length
    ? `注意：${st.pending_already_dreamed.join(", ")} 已沉淀过，memory_dream 会拒绝重跑——要补这些日期必须加 force=true`
    : "";
  return `inbox 积压 ${st.pending_entries} 条（${dates}），${tail}。建议调 memory_dream 沉淀后再继续。${stuck}`;
}

// ── 编排：memory_dream ──────────────────────────────────────────────────────

/** 已沉淀过的日期（JSON 存于 meta）。用于「一天只 dream 一次」的幂等保护。 */
export function dreamedDates(db: DB): string[] {
  try {
    const v = metaGet(db, "dreamed_dates");
    if (!v) return [];
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

/** 记录某个日期已沉淀（去重后按时间排序回写，只保留最近 400 天防无限增长）。 */
export function markDreamed(db: DB, date: string, keep = 400): void {
  const set = new Set([...dreamedDates(db), date]);
  metaSet(db, "dreamed_dates", JSON.stringify([...set].sort().slice(-keep)));
}

export interface DreamRunOpts {
  date?: string;
  dry_run?: boolean;
  sessions?: boolean;
  inbox?: boolean;
  model?: string;
  /** 强制重新处理一个已沉淀过的日期（默认拒绝：一天只 dream 一次，避免同一天反复蒸馏出近重复条目） */
  force?: boolean;
}

export interface DreamRunReport {
  dry_run: boolean;
  date: string;
  model: string;
  force: boolean;
  already_dreamed: boolean;
  /** 运行是否中止（如 date 参数非法）——中止时没有任何写操作发生 */
  aborted: boolean;
  /**
   * 本次是否真的把该日期记为已沉淀。false = 零产出、蒸馏失败、或 inbox 有条目没写成；
   * 此时该日期**没有**被锁进 dreamed_dates，可直接重跑，无需 force。
   */
  marked_dreamed: boolean;
  at: string;
  memory_dir: string;
  db_file: string;
  last_dream_at: string | null;
  elapsed_ms: number;
  extract: SessionExtract | null;
  distill: DistillResult | null;
  inbox: { dates: string[]; entries: number };
  items_planned: number;
  by_kind: Record<string, number>;
  written: WrittenItem[];
  skipped: WriteResult["skipped"];
  /** 未被消费、仍留在 inbox 里的日期（条目没写成，不该被归档当成消费掉） */
  held_back: string[];
  archived: { moved: string[]; skipped: string[]; scrubbed: number };
  tmp_pruned: number;
  reindex: unknown;
  report_file: string;
  warnings: string[];
  note: string;
}

/**
 * dream 主流程：抽取 → 蒸馏 → 写入 dream/ → 报告 → 重建索引 → 归档 inbox。
 *
 * dry_run 只出计划：不写 dream 条目、不建索引、不归档；**但会写一份 dream-dryrun-<时间>.md 报告**
 * （索引侧只认 dream-<yyyymmdd>-<hhmmss>.md，所以干跑不会污染记忆库）。
 *
 * 落账规则：只有「会话蒸馏成功」且「inbox 无条目被搁置」才 markDreamed。
 * 零产出、蒸馏全批失败、或有 inbox 条目没写成时都不标记——否则一次 SenseNova 抽风就把当天会话
 * 永久锁进 dreamed_dates，用户看着"已沉淀 0 条"却以为成功，除非读懂 warning 加 force 才能补救。
 */
export async function memoryDream(opts: DreamRunOpts = {}): Promise<DreamRunReport> {
  const t0 = Date.now();
  const dryRun = !!opts.dry_run;
  const useSessions = opts.sessions ?? true;
  const useInbox = opts.inbox ?? true;
  const force = !!opts.force;
  const model = opts.model || "sensenova-6.8-flash-lite";
  const warnings: string[] = [];
  const now = new Date().toISOString();
  const db = openMemoryDb();
  const last = metaGet(db, "last_dream_at") ?? null;

  // date 参数非法直接中止。过去 dateOk() 会静默落回「今天」，而 inbox 过滤拿到 null 等于不过滤——
  // 一次误传（"not-a-date"）会把整个 inbox 积压扫光并归档，报告却写着「date: 今天」。
  const explicitDate = dateOk(opts.date ?? "");
  const date = explicitDate ?? localDate();
  if (opts.date != null && explicitDate == null) {
    const bad = String(opts.date);
    return {
      dry_run: dryRun, date, model, force, already_dreamed: false, aborted: true, marked_dreamed: false,
      at: now, memory_dir: memoryDir(), db_file: memoryDbFile(), last_dream_at: last,
      elapsed_ms: Date.now() - t0, extract: null, distill: null,
      inbox: { dates: [], entries: 0 }, items_planned: 0, by_kind: {}, written: [], skipped: [],
      held_back: [], archived: { moved: [], skipped: [], scrubbed: 0 }, tmp_pruned: 0, reindex: null,
      report_file: "",
      warnings: [`date 参数 "${bad}" 不是合法的 YYYY-MM-DD`],
      note: `date 参数 "${bad}" 不是合法的 YYYY-MM-DD，已中止（未扫会话、未处理 inbox、未归档、未标记日期）。省略 date 表示处理今天。`,
    };
  }

  // 幂等保护：一个日期只沉淀一次。重复蒸馏同一天会产出措辞不同的近重复条目
  // （实测同一天两次跑分别出 7 条和 12 条，标题相似但正文只重合 0.30~0.36），
  // 标题去重与 0.5 的正文阈值都抓不住这类"换个说法的同一件事"。
  const already = dreamedDates(db).includes(date);
  if (already && !force) {
    // 顺带把该日期的积压数报出来：过去这里返回空 inbox，agent 完全不知道还有多少条没处理
    const backlogged = listInbox().filter(p => p.date === date)[0]?.entries ?? 0;
    const stuck = backlogged > 0
      ? ` 该日期 inbox 仍有 ${backlogged} 条未处理，要补它们必须加 force=true。`
      : "";
    const note = dryRun
      ? `dry_run：${date} 已于此前沉淀过，直接返回（不烧 token）。如需重新蒸馏请加 force=true——注意重跑会追加新条目，可能与既有条目近似重复。${stuck}`
      : `${date} 已于此前沉淀过，已跳过。如需重新蒸馏请加 force=true（会追加新条目，可能产生近似重复；事后可用 dream 去重工具清理）。${stuck}`;
    return {
      dry_run: dryRun, date, model, force, already_dreamed: true, aborted: false, marked_dreamed: false,
      at: now, memory_dir: memoryDir(), db_file: memoryDbFile(), last_dream_at: last,
      elapsed_ms: Date.now() - t0,
      extract: null, distill: null,
      inbox: { dates: [], entries: 0 },
      items_planned: 0, by_kind: {}, written: [], skipped: [],
      held_back: backlogged > 0 ? [date] : [], archived: { moved: [], skipped: [], scrubbed: 0 }, tmp_pruned: 0,
      reindex: null, report_file: "", warnings: [], note,
    };
  }

  // 阶段 1 ── 抽取会话原文
  let extract: SessionExtract | null = null;
  if (useSessions) {
    extract = extractSessions({ date });
    warnings.push(...extract.warnings);
  }

  // 阶段 2 ── LLM 蒸馏
  let distill: DistillResult | null = null;
  if (extract && extract.ok) {
    if (dryRun) warnings.push("dry_run：跳过 LLM 蒸馏（不烧 token），仅报告抽取到的会话体量");
    else {
      distill = await distillRaw(extract.raw_path, { model });
      if (!distill.ok) warnings.push(`蒸馏部分失败：${distill.batches_failed}/${distill.batches} 批出错，已成功批次仍会入库`);
      for (const e of distill.errors.slice(0, 3)) warnings.push(`蒸馏批次 ${e.batch} 出错：${e.error.slice(0, 160)}`);
    }
  }

  // 阶段 3a ── 收集待沉淀条目：inbox（免 LLM）+ 蒸馏结果
  const pending: PendingItem[] = [];
  const inboxDates: string[] = [];
  let inboxEntries = 0;
  if (useInbox) {
    for (const st of listInbox()) {
      if (explicitDate && st.date !== explicitDate) continue;
      inboxDates.push(st.date);
      inboxEntries += st.entries;
      for (const e of parseInboxFile(st.path)) {
        pending.push({
          date: e.date || st.date, kind: e.kind, title: e.title, text: e.text,
          tags: e.tags, confidence: 1, origin: "inbox",
        });
      }
    }
  }
  if (distill) {
    for (const it of distill.items) {
      pending.push({
        date: extract && extract.date ? extract.date : date,
        kind: coerceKind(it.kind), title: it.title, text: it.text,
        tags: cleanTags(it.tags), confidence: it.confidence, origin: "session",
      });
    }
  }

  const byKind: Record<string, number> = {};
  for (const p of pending) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;

  // 阶段 3b ── 写入 dream/ 源目录
  const wres = writeDreamItems(pending, { model, at: now, dryRun });

  // 阶段 4a ── 索引与归档
  const moved: string[] = [];
  const skipArch: string[] = [];
  let scrubArch = 0;
  let reindex: unknown = null;

  // 归档判定：只有「写成了条目」或「被判为重复（内容已存在）」的日期才算消费掉。
  // 全部条目因「正文过短」被跳过的日期不归档——那内容只该留在 inbox 里让 agent 看到，
  // 而不是被搬进 archive 变成事实上的丢弃。
  const consumedDates = new Set([
    ...wres.written.map(w => w.date),
    ...wres.skipped.filter(s => s.disposition !== "too_short").map(s => s.date),
  ]);
  const heldBack = inboxDates.filter(dt => !consumedDates.has(dt));
  if (heldBack.length) warnings.push(`inbox 的 ${heldBack.join(", ")} 未归档：条目未写成，内容仍留在 inbox 里待补`);

  if (!dryRun) {
    if (wres.written.length > 0) {
      try { reindex = scanAndIndex(db); }
      catch (e) { warnings.push(`scanAndIndex 失败：${(e as Error).message}（md 已写入 dream/，可单独跑 memory_reindex 补救）`); }
    }
    const arch = archiveInbox(inboxDates.filter(dt => consumedDates.has(dt)));
    moved.push(...arch.moved);
    skipArch.push(...arch.skipped);
    scrubArch = arch.scrubbed;
  }

  // 阶段 4b ── 落账
  // 会话部分是否真的处理完：未启用会话 / 当天无回合可蒸馏 / 蒸馏成功，都算完成
  const sessionsConsumed = !useSessions || extract == null || extract.turns === 0 || (distill != null && distill.ok);
  const didWork = wres.written.length > 0 || pending.length > 0 || distill != null;
  const marked = sessionsConsumed && heldBack.length === 0 && didWork;

  if (!dryRun && marked) {
    metaSet(db, "last_dream_at", now);
    metaSet(db, "last_dream_date", date);
    metaSet(db, "last_dream_items", String(pending.length));
    markDreamed(db, date);
  }
  if (!dryRun && !marked) {
    warnings.push(
      `本次未把 ${date} 记为已沉淀（会话蒸馏 ${distill == null ? "未运行" : (distill.ok ? "成功" : "失败")}，写出 ${wres.written.length} 条，搁置 ${heldBack.length} 个日期）——该日期可安全重跑，无需 force`,
    );
  }

  // 阶段 4c ── 清理蒸馏流水（该目录过去从不清理，每次蒸馏都留一个 JSON 累积下去）
  let tmpPruned = 0;
  if (!dryRun) {
    try { tmpPruned = pruneDreamTmp().length; }
    catch (e) { warnings.push(`.dream_tmp 清理失败：${(e as Error).message}`); }
  }

  const ri = reindex as { total_docs?: number; added?: number; removed?: number; elapsed_ms?: number } | null;
  const reindexText = ri && ri.total_docs != null
    ? `索引共 ${ri.total_docs} 篇（+${ri.added ?? 0}）`
    : "索引未重建（无新条目）";
  const note = dryRun
    ? `dry_run 计划：${pending.length} 条待沉淀（user_fact ${byKind.user_fact ?? 0} / workflow ${byKind.workflow ?? 0} / note ${byKind.note ?? 0}），${wres.written.length} 条可写、${wres.skipped.length} 条重复跳过；未写 dream 条目、未建索引、未归档（报告写为 dream-dryrun-*.md，不进索引）。确认无误后去掉 dry_run 重跑。`
    : marked
      ? `已沉淀 ${wres.written.length} 条（重复跳过 ${wres.skipped.length} 条）→ dream/ 目录；${reindexText}；inbox 归档 ${moved.length} 个文件${scrubArch ? `（归档前清扫密钥 ${scrubArch} 个文件）` : ""}。用 memory_search 检索时用 source=dream_fact/dream_workflow/dream_note 缩小范围。`
      : `本次没有产出可沉淀的内容（写出 ${wres.written.length} 条 / 计划 ${pending.length} 条），${date} 未记为已沉淀——可直接重跑，无需 force。${distill && !distill.ok ? `蒸馏失败：${distill.errors.slice(0, 1).map(e => e.error).join(" ").slice(0, 180)}` : ""}${heldBack.length ? `inbox 的 ${heldBack.join(", ")} 有条目未写成，仍留在 inbox 里。` : ""}`;

  const report = [
    `# Dream 沉淀报告 ${stamp()}${dryRun ? "（dry_run）" : ""}`,
    "",
    `- **dry_run**: ${dryRun}`,
    `- **date**: ${date}`,
    `- **model**: ${model}`,
    `- **force**: ${force}`,
    `- **上次 dream**: ${last ?? "（从未）"}`,
    `- **本次标记为已沉淀**: ${dryRun ? "否（dry_run）" : marked}`,
    "",
    "## 阶段 1 · 会话抽取",
    extract
      ? `- sessions ${extract.sessions} · turns ${extract.turns}（user ${extract.user_turns} / assistant ${extract.assistant_turns}）· ${extract.chars} 字符`
      : "- 未执行（sessions=false）",
    extract && extract.raw_rel ? `- raw: ${extract.raw_rel}` : "",
    "",
    "## 阶段 2 · LLM 蒸馏",
    distill
      ? `- batches ${distill.batches}（失败 ${distill.batches_failed}）· items ${distill.items.length} · dropped ${distill.dropped.length} · ${distill.elapsed_ms}ms`
      : (extract && extract.ok ? "- dry_run 跳过" : "- 无输入，跳过"),
    "",
    `## 阶段 3 · 写入（计划 ${pending.length} 条 / 实际 ${wres.written.length} 条）`,
    "",
    "| kind | 计划 | 实际写入目标 |",
    "|------|------|------|",
    ...(["user_fact", "workflow", "note"] as DreamKind[]).map(k => {
      const targets = wres.written.filter(w => w.kind === k).map(w => w.target).join("<br>");
      return `| ${k} | ${byKind[k] ?? 0} | ${targets || "—"} |`;
    }),
    "",
    wres.skipped.length ? `**跳过 ${wres.skipped.length} 条**：` + wres.skipped.map(s => `\n- ${s.title} — ${s.reason}`).join("") : "",
    "",
    "## 阶段 4 · 索引与归档",
    ri && ri.total_docs != null
      ? `- scanAndIndex: +${ri.added ?? 0} / -${ri.removed ?? 0} / 共 ${ri.total_docs} 篇 / ${ri.elapsed_ms ?? 0}ms`
      : "- 未重建索引",
    `- 归档: ${moved.length ? moved.join(", ") : "无"}${scrubArch ? `（清扫密钥 ${scrubArch} 个文件）` : ""}`,
    `- 搁置（未归档，仍在 inbox）: ${heldBack.length ? heldBack.join(", ") : "无"}`,
    `- .dream_tmp 清理: ${tmpPruned ? `${tmpPruned} 个过期蒸馏流水` : "无"}`,
    "",
    "## 条目明细",
    pending.length === 0 ? "（无）" : "",
    "",
    "| 来源 | kind | title | confidence |",
    "|------|------|------|------|",
    ...pending.slice(0, 80).map(p => `| ${p.origin} | ${p.kind} | ${p.title.replace(/\|/g, "/")} | ${p.confidence} |`),
    pending.length > 80 ? `\n_（另有 ${pending.length - 80} 条未列出）_` : "",
    "",
    // 刻意不写「蒸馏丢弃候选」明细：那是 LLM 判定不该记住的内容，而报告本身又被索引，
    // 写进去等于让明确丢弃的东西绕一圈重新变成可检索记忆。丢弃数量在阶段 2 里已报。
    warnings.length ? "## 警告\n" + warnings.map(w => `- ${w}`).join("\n") + "\n" : "",
  ].filter(l => l !== null);

  let reportFile = "";
  try { reportFile = writeDreamReport(report, { dryRun }); }
  catch (e) { warnings.push(`报告写入失败：${(e as Error).message}`); }

  return {
    dry_run: dryRun, date, model, force, already_dreamed: already, aborted: false, marked_dreamed: marked,
    at: now, memory_dir: memoryDir(), db_file: memoryDbFile(),
    last_dream_at: last,
    elapsed_ms: Date.now() - t0,
    extract, distill,
    inbox: { dates: inboxDates, entries: inboxEntries },
    items_planned: pending.length,
    by_kind: byKind,
    written: wres.written,
    skipped: wres.skipped,
    held_back: heldBack,
    archived: { moved, skipped: skipArch, scrubbed: scrubArch },
    tmp_pruned: tmpPruned,
    reindex,
    report_file: reportFile ? cleanRel(reportFile) : "",
    warnings,
    note,
  };
}
