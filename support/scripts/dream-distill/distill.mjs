#!/usr/bin/env node
/**
 * dream-distill — 会话记忆蒸馏 runner（独立子进程，供 pi 的 memory_dream 工具调用）
 *
 * 职责：读 memory_dream 阶段1 抽出的会话原文（raw extract md），分批送 SenseNova LLM，
 *       蒸馏出「值得长期保存」的结构化记忆条目，输出 JSON。
 *
 * 为何走子进程而不是在 pi 进程内 fetch：
 *   - 与 support/scripts/rag-rebuild/ 同一模式，可观测、可单独跑、不挂 pi
 *   - 密钥只在子进程内读入，不进 pi 进程内存与日志
 *
 * 凭证：~/.env 中按序找 SenseNova_account1_API_KEY / account3（account2 为 pi 本体所用，后台避开）
 *       base_url 取 SENSENOVA_BASE_URL，默认 https://token.sensenova.cn/v1。密钥只进环境变量，不打印、不落盘。
 *
 * Usage:
 *   node distill.mjs <raw_extract.md> [--out result.json] [--model sensenova-6.8-flash-lite]
 *                            [--batch-chars 40000] [--max-items 12] [--min-confidence 0.7]
 *                            [--concurrency 2] [--timeout 180]
 *   node distill.mjs --list-keys        # 只校验凭证可用性，不调用 API、不烧 token
 *
 * 输出 JSON：
 *   { ok, model, date_hint, batches, elapsed_ms, items: [{kind,title,text,tags,confidence,batch}],
 *     dropped: [{summary,reason}], errors: [{batch,error}] }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const ENV_FILE = join(homedir(), ".env");
const DEFAULT_BASE = "https://token.sensenova.cn/v1";
const DEFAULT_MODEL = "sensenova-6.8-flash-lite";
const KEY_VARS = ["SenseNova_account1_API_KEY", "SenseNova_account3_API_KEY"]; // 后台专用：避开 account2（pi 本体在用）
const KINDS = new Set(["user_fact", "workflow", "note"]);
/** LLM 常把品类名/流程名当标签输出，没有检索价值，直接剔除。 */
const TAG_NOISE = new Set([
  ...KINDS,
  "fact", "dream", "kind", "tags", "title", "memory", "agent", "llm", "item", "json",
  "记忆", "蒸馏", "工作流", "用户事实", "技术笔记", "结论", "标签", "品类", "分类",
]);

// ── 参数 ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { _: [], flag: {} };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      if (eq > 0) a.flag[t.slice(2, eq)] = t.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) { a.flag[t.slice(2)] = next; i++; }
        else a.flag[t.slice(2)] = true;
      }
    } else a._.push(t);
  }
  return a;
}

// ── 凭证 ────────────────────────────────────────────────────────────────────

/** 读 ~/.env（不打印任何值）。返回 { key, base, used } 或 null。 */
function loadCreds() {
  if (!existsSync(ENV_FILE)) return { error: `未找到 ${ENV_FILE}` };
  const env = {};
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const i = s.indexOf("=");
    env[s.slice(0, i).trim()] = s.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  let used = null, key = null;
  for (const n of KEY_VARS) if (env[n]) { used = n; key = env[n]; break; }
  if (!key) return { error: `${ENV_FILE} 中未找到可用的 SenseNova key（已试 ${KEY_VARS.join(" / ")}）` };
  return { key, base: env.SENSENOVA_BASE_URL || env.LLM_BASE_URL || DEFAULT_BASE, used };
}

// ── LLM 调用 ────────────────────────────────────────────────────────────────

const SYS_PROMPT = (maxItems) => `你是记忆蒸馏器。输入是一段人与 AI 助手的会话记录（可能来自不同项目、跨多个话题）。
你的唯一任务是抽取**值得长期保存**的记忆条目，丢弃一切一次性、临时、寒暄、工具输出内容的信息。

## 只抽取这三类

- **user_fact**：关于用户本人的持久事实——身份/单位/研究方向、长期偏好与沟通习惯、稳定的环境与路径事实、工具与账号约定。
  判断标准：三个月后大概率仍成立，且 agent 不知道它会在同类任务上反复出错。
- **workflow**：可重复的操作流程——用户认可过的步骤顺序、绕坑方法、某类任务的标准做法、环境配置的固定套路、踩过的流程坑。
  判断标准：下次遇到同类任务应当照做。
- **note**：技术结论与踩坑——某个技术点上的结论、失败根因与修复方式、版本/依赖/数据口径限制、实测数值与判断依据。
  判断标准：下次遇到可直接复用，不必重新推导。

## 一律丢弃

- 具体一次性任务的执行过程、进度汇报、寒暄与确认（「好的」「继续」「你试试」）
- 工具输出的原始内容、长报错日志的逐字复述（但报错的**根因与解法**属于 note）
- 关于「正在搭建/修改某个系统」的元讨论，除非产出了一条可复用的通用经验
- 会话内部被后续内容推翻的说法（只留最终结论）
- 敏感信息：密钥值、密码、token **原文与任何片段**一律不得写入——包括以 sk-、Bearer、ghp_、AKIA 开头的字符串，以及
  只保留前几位的写法（如 sk-a1B... 这种也算泄漏）。**只允许写变量名指向**，例如「SenseNova 的 key 在 ~/.env 的 SenseNova_account1_API_KEY」，
  绝不允许出现该变量的取值或其前缀
- 已在会话中明确表达「不要这样」的做法（除非该禁令本身有持久价值，那归 workflow）

## 输出格式（只输出 JSON，不要解释、不要 markdown 代码围栏）

{
  "items": [
    {
      "kind": "user_fact",
      "title": "12字以内名词短语，能被关键词搜到",
      "text": "1-5 句自包含陈述。必须带具体细节（路径、命令、文件名、数值、项目名、日期），脱离上下文也能读懂。",
      "tags": ["rockburst", "FLAC3D"],
      "confidence": 0.9
    }
  ],
  "dropped": [
    { "summary": "被丢弃的高价值候选，一句话", "reason": "为什么不值得长期保存" }
  ]
}

## 硬约束

1. items 最多 ${maxItems} 条；宁缺毋滥，宁可 0 条也不要凑数。
2. confidence < 0.7 的条目直接不要输出。
3. text 严禁编造会话中未出现的信息；不确定的数值、版本号、路径一律不写。
4. 同一事实只输出一次，不要换措辞重复；同一话题的多条相近条目应合并。
5. kind 只能是 user_fact / workflow / note 之一。
6. 若整段会话没有值得保存的记忆，输出 {"items": [], "dropped": []}。`;

function extractJson(text) {
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (s.startsWith("```")) s = s.slice(3).trim();
  if (s.endsWith("```")) s = s.slice(0, -3).trim();
  const l = s.indexOf("{");
  const r = s.lastIndexOf("}");
  if (l < 0 || r <= l) return null;
  try { return JSON.parse(s.slice(l, r + 1)); } catch { return null; }
}

/**
 * 密钥清扫：LLM 可能违反 prompt 把密钥值（或其前缀）写进记忆，这里做兜底替换。
 * 只保留"变量名指向"这类信息，绝不保留取值。返回 { text, scrubbed }。
 */
const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9_\-]{6,}\.?\.*\.?\*{0,3}/g, "sk-****"],                      // OpenAI/SenseNova 风格
  [/AKIA[0-9A-Z]{6,}/g, "AKIA****"],                                          // AWS
  [/gh[pousr]_[A-Za-z0-9]{10,}/g, (m) => m.slice(0, m.indexOf("_") + 1) + "****"], // GitHub
  [/github_pat_[A-Za-z0-9_]{10,}/g, "github_pat_****"],
  [/glpat-[A-Za-z0-9_\-]{6,}/g, "glpat-****"],                                // GitLab
  [/xox[bpars]-[A-Za-z0-9-]{6,}/g, "xox?-****"],                              // Slack
  [/Bearer\s+[A-Za-z0-9._\-]{10,}/gi, "Bearer ****"],
  [/\b([a-zA-Z_]*(?:key|token|secret|password|passwd|pwd))\b([=:])(\s*)([^&\s,，。；;"'）)]{6,})/gi,
    (_m, k, sep, sp, _v) => `${k}${sep}${sp}****`],                                    // password=xxx / key: xxx / api_key=xxx
  [/\b[A-Za-z0-9+\/]{40,}={0,2}\b/g, "****"],                                 // 长不透明串（base64/指纹等）
];

export function scrubSecrets(text) {
  let s = String(text ?? "");
  let scrubbed = 0;
  for (const [re, sub] of SECRET_PATTERNS) {
    const before = s;
    s = s.replace(re, sub);
    if (s !== before) scrubbed++;
  }
  return { text: s, scrubbed };
}

function cleanItem(o, batch, minConf) {
  if (!o || typeof o !== "object") return null;
  const kind = KINDS.has(o.kind) ? o.kind : null;
  let text = String(o.text ?? "").replace(/\s+/g, " ").trim();
  let title = String(o.title ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || text.slice(0, 40);
  if (!kind || text.length < 20) return null;
  const conf = Math.max(0, Math.min(1, Number(o.confidence ?? 0)));
  if (conf < minConf) return null;
  // 兜底清扫密钥（prompt 已禁止，但 LLM 会漏，尤其"只写前缀"的写法）
  const st = scrubSecrets(text);
  text = st.text;
  const scrubbed = st.scrubbed + scrubSecrets(title).scrubbed;
  title = scrubSecrets(title).text;
  const tags = Array.isArray(o.tags)
    ? [...new Set(o.tags.map(t => String(t).trim().toLowerCase().replace(/^#+/, "").replace(/\s+/g, " "))
        .filter(t => t && t.length <= 40 && !TAG_NOISE.has(t)))].slice(0, 8)
    : [];
  return { kind, title, text, tags, confidence: conf, batch, scrubbed };
}

/** 把 raw extract 切成批次：按 ### 回合为单位贪心打包，单回合超长则截断。 */
function makeBatches(text, batchChars, perTurnMax) {
  const re = /\n###\s+\[(user|assistant)\]\s+(\S+)\s*\n/g;
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) marks.push({ i: m.index, who: m[1], at: m[2] });
  const blocks = marks.map((mk, k) => {
    const end = k + 1 < marks.length ? marks[k + 1].i : text.length;
    let body = text.slice(mk.i, end).trim();
    if (body.length > perTurnMax) body = body.slice(0, perTurnMax) + "\n\n[... 单回合超长，已截断 ...]";
    return body;
  });
  const batches = [];
  let cur = "";
  for (const b of blocks) {
    if (cur && cur.length + b.length + 1 > batchChars) { batches.push(cur); cur = b; }
    else cur = cur ? cur + "\n" + b : b;
  }
  if (cur.trim()) batches.push(cur.trim());
  return batches;
}

async function callOnce(key, base, model, userContent, maxItems, timeoutSec) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutSec * 1000);
  try {
    const resp = await fetch(`${String(base).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      // Connection: close —— 不让 undici 保留 keep-alive socket，否则退出时会残留句柄，
      // 被迫 process.exit() 会触发 Windows libuv 断言（UV_HANDLE_CLOSING）。
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Connection": "close" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYS_PROMPT(maxItems) },
          { role: "user", content: userContent },
        ],
        temperature: 0.2,
        max_tokens: 4000,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      let detail = "";
      try { detail = (await resp.text()).slice(0, 200); } catch {}
      throw new Error(`HTTP ${resp.status} ${detail}`.replace(key, "[redacted]"));
    }
    const j = await resp.json();
    return { text: String(j.choices?.[0]?.message?.content ?? ""), usage: j.usage ?? null };
  } finally {
    clearTimeout(timer);
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const argv = parseArgs(process.argv.slice(2));

/** 用于「已打印结果、正常收尾」的哨兵：抛出即结束主流程，避免任何 process.exit()。 */
class AbortMain extends Error {}

/**
 * 退出策略：一律只设置 process.exitCode，让事件循环自行排空后自然退出。
 * 直接 process.exit() 在 Windows 上会撞 libuv 断言
 * （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c），
 * 因为 fetch 的 keep-alive socket 与正在关闭的句柄发生竞态；配合 callOnce 的
 * `Connection: close` 关掉连接复用，退出时已无残留句柄。
 */
try {
  if (argv.flag["list-keys"]) {
    const c = loadCreds();
    console.log(JSON.stringify(c.error
      ? { ok: false, error: c.error }
      : { ok: true, key_var: c.used, base_url: c.base, model: argv.flag.model || DEFAULT_MODEL, env_file: ENV_FILE }, null, 2));
    process.exitCode = c.error ? 1 : 0;
    throw new AbortMain();
  }

  const rawPath = argv._[0];
  const model = argv.flag.model || DEFAULT_MODEL;
  const batchChars = Number(argv.flag["batch-chars"] || 40000);
  const maxItems = Number(argv.flag["max-items"] || 12);
  const minConf = Number(argv.flag["min-confidence"] || 0.7);
  const concurrency = Math.max(1, Math.min(4, Number(argv.flag.concurrency || 2)));
  const timeoutSec = Number(argv.flag.timeout || 180);
  const perTurnMax = Math.min(4000, batchChars);

  const fail = (error, extra = {}) => {
    console.log(JSON.stringify({ ok: false, error, ...extra }, null, 2));
    throw new AbortMain();
  };

  if (!rawPath) fail("缺少 <raw_extract.md> 参数（或传 --list-keys 只校验凭证）");
  if (!existsSync(rawPath)) fail(`raw extract 不存在：${rawPath}`);

  const creds = loadCreds();
  if (creds.error) fail(creds.error);

  const raw = readFileSync(rawPath, "utf8");
  const batches = makeBatches(raw, batchChars, perTurnMax);
  if (batches.length === 0) fail(`raw extract 中没有可蒸馏的回合（缺少 "### [user]" / "### [assistant]" 标记）：${rawPath}`);

  const t0 = Date.now();
  const all = [];
  const dropped = [];
  const errors = [];
  const seenKey = new Set();
  let scrubbedTotal = 0;
  const queue = batches.map((b, i) => ({ b, i }));

  async function runOne(job) {
    try {
      const { text } = await callOnce(creds.key, creds.base, model, job.b, maxItems, timeoutSec);
      const j = extractJson(text);
      if (!j) throw new Error(`LLM 未返回可解析 JSON（响应前 120 字：${text.slice(0, 120).replace(/\s+/g, " ")}）`);
      if (Array.isArray(j.items)) {
        for (const it of j.items) {
          const c = cleanItem(it, job.i, minConf);
          if (!c) continue;
          const k = `${c.kind}\u0000${c.text.slice(0, 60).toLowerCase()}`;
          if (seenKey.has(k)) continue;
          seenKey.add(k);
          scrubbedTotal += c.scrubbed || 0;
          all.push(c);
        }
      }
      if (Array.isArray(j.dropped)) {
        for (const d of j.dropped.slice(0, 10)) {
          if (d && d.summary) dropped.push({ summary: String(d.summary).slice(0, 200), reason: String(d.reason ?? "").slice(0, 200), batch: job.i });
        }
      }
    } catch (e) {
      errors.push({ batch: job.i, error: String(e && e.message || e).slice(0, 300) });
    }
  }

  // 受限并发
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) break;
      await runOne(job);
    }
  }));

  const out = {
    ok: errors.length < batches.length,
    model,
    input_file: rawPath,
    input_bytes: Buffer.byteLength(raw),
    batches: batches.length,
    batches_failed: errors.length,
    elapsed_ms: Date.now() - t0,
    items: all,
    scrubbed_total: scrubbedTotal,
    dropped,
    errors,
  };

  if (argv.flag.out) {
    mkdirSync(dirname(argv.flag.out), { recursive: true });
    writeFileSync(argv.flag.out, JSON.stringify(out, null, 2), "utf8");
    console.log(JSON.stringify({ ok: out.ok, out: argv.flag.out, items: all.length, batches: batches.length,
      failed: errors.length, elapsed_ms: out.elapsed_ms }, null, 2));
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
  process.exitCode = out.ok ? 0 : 1;
} catch (e) {
  if (!(e instanceof AbortMain)) {
    console.log(JSON.stringify({ ok: false, error: String(e && (e.stack || e.message || e)) }, null, 2));
    process.exitCode = 1;
  }
}
