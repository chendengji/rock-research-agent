/**
 * sensenova.ts — SenseNova（商汤日日新，OpenAI 兼容）LLM 客户端，
 * 用于 claim_verify 的蕴含判定（接地第 4 步）与 memory_dream 蒸馏。
 *
 * 端点/模型/key 与 extract_claims_llm.py 完全一致（同一抽取用 key）：
 *   base = https://token.sensenova.cn/v1，model = sensenova-6.8-flash-lite
 *   key 从 ~/.env 读 SenseNova_account1_API_KEY（优先）/ account3。
 *   ⚠️ account2 是 pi 本体（models.json）在用，后台一律避开，防止单账户限流。
 * 密钥只进内存、不落盘、不打印、不进工具输出。
 *
 * 唯一对外能力：entail(claim, source) → {label, reason}
 *   label: SUPPORTS | CONTRADICTS | NOT_ADDRESSED
 *   用于判 CORRECT / MISATTRIBUTED（NOT_ADDRESSED 或 CONTRADICTS = claim 扭曲/冒充了源）。
 */

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { setDefaultResultOrder } from "node:dns";

// 强制 IPv4 优先：某些 .cn 域名的 AAAA 记录无全局路由，IPv6 连接会 Errno 101 超时。
// Node fetch 默认不开 autoSelectFamily，不设此项验证会间歇性 60s 超时失败。
setDefaultResultOrder("ipv4first");

const DEFAULT_BASE_URL = "https://token.sensenova.cn/v1";
const DEFAULT_MODEL = "sensenova-6.8-flash-lite";
const ENV_FILE = join(homedir(), ".env");
const KEY_VARS = ["SenseNova_account1_API_KEY", "SenseNova_account3_API_KEY"]; // 后台专用：避开 account2（pi 本体在用）

let _cachedKey: string | null | undefined;

/** 读 SenseNova key（只返回值给调用方用，绝不打印）。无则返回 null。 */
function loadKey(): string | null {
  if (_cachedKey !== undefined) return _cachedKey;
  if (process.env.SENSENOVA_API_KEY) { _cachedKey = process.env.SENSENOVA_API_KEY; return _cachedKey; }
  if (!existsSync(ENV_FILE)) { _cachedKey = null; return null; }
  let key: string | null = null;
  try {
    const txt = readFileSync(ENV_FILE, "utf-8");
    for (const v of KEY_VARS) {
      const m = txt.match(new RegExp(`^${v}\\s*=\\s*(.+)$`, "m"));
      if (m && m[1].trim()) {
        key = m[1].trim().replace(/^["']|["']$/g, "");
        break;
      }
    }
  } catch { /* ignore */ }
  _cachedKey = key;
  return _cachedKey;
}

/** SenseNova 是否可用（key 存在）。claim_verify 用它决定是否走 LLM 判官。 */
export function sensenovaAvailable(): boolean {
  return !!loadKey();
}

export type EntailLabel = "SUPPORTS" | "CONTRADICTS" | "NOT_ADDRESSED";
export interface EntailResult {
  label: EntailLabel;
  reason: string;
}

const ENTAIL_SYS = `你是一个严格的引用验证判官。给你一个 CLAIM 和一段 SOURCE PASSAGE（引自所引论文的原文），判断该原文段是否支持这个 claim。
只回复 JSON：{"label":"SUPPORTS"|"CONTRADICTS"|"NOT_ADDRESSED","reason":"<一句简短理由>"}

判定标准：
- SUPPORTS：原文段直接或间接支撑 claim 的论断/数值/因果。
- CONTRADICTS：原文段陈述与 claim 冲突。
- NOT_ADDRESSED：原文段不涉及 claim 的实质内容——即使引用真实，但 claim 夹带了原文没有的细节/数值/因果（这正是 MISATTRIBUTION：扭曲/冒充原文）。
要严格：claim 若有原文未出现的数值/因果/范围扩展，一律 NOT_ADDRESSED。
不要输出 markdown 代码块或解释文字，只输出 JSON。`;

/**
 * 调 SenseNova 判 claim vs source 的蕴含关系。
 * 失败抛异常；上层 try/catch 降级为"无 LLM 判定"。
 */
export async function entail(claim: string, source: string): Promise<EntailResult> {
  const key = loadKey();
  if (!key) throw new Error(`SenseNova key 未在 ~/.env 找到（已试 ${KEY_VARS.join(" / ")}）`);
  const user = `CLAIM:\n${claim}\n\nSOURCE PASSAGE:\n${source}`;
  const content = await chatSensenova(ENTAIL_SYS, user, 0, 256);
  let cleaned = content.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
  // 容忍 LLM 偶尔在 JSON 前后加文字：截取第一个 { 到最后一个 }
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);
  const parsed = JSON.parse(cleaned);
  const label = String(parsed.label).toUpperCase();
  if (label !== "SUPPORTS" && label !== "CONTRADICTS" && label !== "NOT_ADDRESSED") {
    throw new Error(`SenseNova 返回未知 label: ${label}`);
  }
  return { label, reason: String(parsed.reason ?? "").slice(0, 300) };
}

/** 通用 SenseNova chat 调用，返回 message.content 文本。 */
export async function chatSensenova(system: string, user: string, temperature = 0.2, maxTokens = 2048): Promise<string> {
  const key = loadKey();
  if (!key) throw new Error(`SenseNova key 未在 ~/.env 找到（已试 ${KEY_VARS.join(" / ")}）`);
  const resp = await fetch(`${DEFAULT_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`SenseNova HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }
  const data: any = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("SenseNova 响应无 content");
  return content;
}

export const SENSENOVA_MODEL = DEFAULT_MODEL;
