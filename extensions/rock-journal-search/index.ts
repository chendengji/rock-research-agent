/**
 * rock-journal-search — Pi Extension for priority-ranked literature search
 *
 * 期刊优先级文献检索：CrossRef / OpenAlex / Semantic Scholar 三个官方开放 API
 * 并发检索 → 按 DOI/标题去重合并 → 交给 journal-search 技能的 journal_rank.py
 * 做四维评分（期刊等级 35 + 引用热度 25 + 时效性 15 + 关键词 25）→ 排序返回。
 *
 * 设计原则（与用户 CLAUDE.md 一致）：
 *   - 只用官方开放 API（CrossRef REST / OpenAlex REST / Semantic Scholar Graph），
 *     不做 Sci-Hub、不爬取 Academia/ResearchGate；
 *   - Semantic Scholar key 只从环境读（SEMANTIC_SCHOLAR_API_KEY / S2_API_KEY，
 *     回落解析 ~/.env），不落盘、不打印；
 *   - 单源失败不影响整体：每个源 try/catch，返回 per-source status。
 *
 * 注册：pi install <本包根>（rock-research-agent 根 package.json 的 pi.extensions 已含本扩展）
 * 工具：journal_search / get_paper_by_id / get_citation / journal_tiers
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir, homedir } from "os";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
// 技能默认解析到包根 skills/journal-search；单独部署时可用 JOURNAL_SKILL_DIR 覆盖
const SKILL_DIR = process.env.JOURNAL_SKILL_DIR || join(EXT_DIR, "..", "..", "skills", "journal-search");
const RANK_SCRIPT = join(SKILL_DIR, "scripts", "journal_rank.py");
const TIERS_JSON = join(SKILL_DIR, "references", "journal_tiers.json");
const MAILTO = process.env.OPENALEX_MAILTO || process.env.CROSSREF_MAILTO || "rock-research@localhost";
const FETCH_TIMEOUT_MS = 15000;
const REQUEST_INTERVAL_MS = 500;  // 请求间隔保护，避免限流
const CURRENT_YEAR = new Date().getFullYear();

/**
 * Python 运行器（journal_rank.py 仅用标准库）：优先技能目录自带环境（skills/journal-search/.venv），
 * 不存在时再按 uv run --directory <技能目录> → 系统 python 兜底。
 * 不再读全局 ROCK_PYTHON 环境变量——环境随技能目录管理。
 */
function resolvePythonRunner(): { cmd: string; args: string[] } {
  const venvPy = process.platform === "win32"
    ? join(SKILL_DIR, ".venv", "Scripts", "python.exe")
    : join(SKILL_DIR, ".venv", "bin", "python");
  if (existsSync(venvPy)) return { cmd: venvPy, args: [] };
  try {
    const r = spawnSync("uv", ["run", "--directory", SKILL_DIR, "python"], { stdio: "ignore" });
    if (r.status === 0) return { cmd: "uv", args: ["run", "--directory", SKILL_DIR, "python"] };
  } catch { /* 无 uv */ }
  return { cmd: process.platform === "win32" ? "python" : "python3", args: [] };
}

// ── 请求间隔保护 ──
let _lastRequestTime = 0;
async function sleepUntilNext() {
  const now = Date.now();
  const elapsed = now - _lastRequestTime;
  if (elapsed < REQUEST_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, REQUEST_INTERVAL_MS - elapsed));
  }
  _lastRequestTime = Date.now();
}

// ── 指数退避重试（遇 429 自动重试）──
async function fetchJsonWithRetry(url: string, headers: Record<string, string> = {}, maxRetries = 3): Promise<any> {
  let lastError: unknown;
  for (let i = 0; i < maxRetries; i++) {
    await sleepUntilNext();
    try {
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (r.status === 429) {
        // 限流：等待后重试
        const retryAfter = parseInt(r.headers.get('retry-after') || '1');
        lastError = new Error(`HTTP 429 (rate limited) for ${url.slice(0, 120)}`);
        await new Promise(res => setTimeout(res, (retryAfter * 1000) + 1000));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.slice(0, 120)}`);
      return r.json();
    } catch (e: any) {
      lastError = e;
      if (i === maxRetries - 1) break;
      await new Promise(res => setTimeout(res, 1000 * (i + 1))); // 指数退避
    }
  }
  // 重试耗尽：必须 throw（否则返回 undefined 会被上层当作 0 结果、吞掉错误）
  throw lastError ?? new Error(`fetch failed for ${url.slice(0, 120)}`);
}

// ── 凭证：只读环境，回落 ~/.env（与 extract_claims_llm.py 同一约定），不外泄 ──
function envKey(name: string): string | undefined {
  const v = process.env[name];
  if (v && v.trim()) return v.trim();
  try {
    // 用 os.homedir() 定位，不写死用户路径（Windows 下 process.env.HOME 常未设置）
    for (const line of readFileSync(join(homedir(), ".env"), "utf-8").split("\n")) {
      const m = line.match(new RegExp(`^${name}\\s*=\\s*(.*)$`));
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* ~/.env 不存在则无 key（S2 走匿名限流） */ }
  return undefined;
}
const S2_KEY = envKey("SEMANTIC_SCHOLAR_API_KEY") || envKey("S2_API_KEY");

// ── 小工具 ──
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const stripTags = (s: string | null | undefined) => (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function invertIndex(ii: Record<string, number[]> | null | undefined): string {
  if (!ii) return "";
  const pos: string[] = [];
  for (const [word, idxs] of Object.entries(ii)) for (const i of idxs) pos[i] = word;
  return pos.join(" ");
}

interface Paper {
  title: string; abstract: string; journal: string; year: number | null;
  citation_count: number; doi: string; url: string; authors: string[]; source: string;
}

// fetchJson 已替换为 fetchJsonWithRetry，保留别名兼容旧调用
const fetchJson = fetchJsonWithRetry;

// ── 三个官方源 ──
async function searchCrossRef(q: string, rows: number, yearFrom?: number): Promise<Paper[]> {
  const params = new URLSearchParams({
    query: q, rows: String(rows), mailto: MAILTO,
    select: "DOI,title,author,container-title,is-referenced-by-count,issued,URL,abstract,type",
    filter: "type:journal-article" + (yearFrom ? `,from-pub-date:${yearFrom}-01-01` : ""),
  });
  const d = await fetchJson(`https://api.crossref.org/works?${params}`);
  return (d?.message?.items || []).map((it: any) => ({
    title: (it.title || [])[0] || "",
    abstract: stripTags(it.abstract),
    journal: (it["container-title"] || [])[0] || "",
    year: it.issued?.["date-parts"]?.[0]?.[0] ?? null,
    citation_count: it["is-referenced-by-count"] || 0,
    doi: it.DOI || "",
    url: it.URL || (it.DOI ? `https://doi.org/${it.DOI}` : ""),
    authors: (it.author || []).map((a: any) => [a.given, a.family].filter(Boolean).join(" ")),
    source: "crossref",
  } as Paper));
}

async function searchOpenAlex(q: string, rows: number, yearFrom?: number): Promise<Paper[]> {
  const params = new URLSearchParams({ search: q, "per-page": String(rows), mailto: MAILTO });
  if (yearFrom) params.set("filter", `from_publication_date:${yearFrom}-01-01`);
  const d = await fetchJson(`https://api.openalex.org/works?${params}`);
  return (d?.results || []).map((w: any) => {
    const doi = (w.doi || "").replace(/^https?:\/\/doi\.org\//i, "");
    return {
      title: w.title || "",
      abstract: invertIndex(w.abstract_inverted_index),
      journal: w.primary_location?.source?.display_name || w.host_venue?.display_name || "",
      year: w.publication_year ?? null,
      citation_count: w.cited_by_count || 0,
      doi,
      url: w.doi || (doi ? `https://doi.org/${doi}` : w.id || ""),
      authors: (w.authorships || []).map((a: any) => a.author?.display_name || "").filter(Boolean),
      source: "openalex",
    } as Paper;
  });
}

async function searchSemanticScholar(q: string, rows: number, yearFrom?: number): Promise<Paper[]> {
  const params = new URLSearchParams({
    query: q, limit: String(rows),
    fields: "title,authors,year,citationCount,externalIds,venue,abstract,url,openAccessPdf",
  });
  if (yearFrom) params.set("year", `${yearFrom}-${CURRENT_YEAR}`);
  const headers: Record<string, string> = {};
  if (S2_KEY) headers["x-api-key"] = S2_KEY;
  const d = await fetchJson(`https://api.semanticscholar.org/graph/v1/paper/search?${params}`, headers);
  return (d?.data || []).map((p: any) => ({
    title: p.title || "",
    abstract: p.abstract || "",
    journal: p.venue || "",
    year: p.year ?? null,
    citation_count: p.citationCount || 0,
    doi: p.externalIds?.DOI || "",
    url: p.openAccessPdf?.url || p.url || "",
    authors: (p.authors || []).map((a: any) => a.name || ""),
    source: "semantic_scholar",
  } as Paper));
}

// ── 去重合并（DOI 优先，其次标题归一化）──
function mergePapers(lists: Paper[][]): Paper[] {
  const seen = new Map<string, Paper>();
  for (const list of lists) for (const p of list) {
    const key = p.doi ? `doi:${p.doi.toLowerCase()}` : `t:${norm(p.title)}`;
    const prev = seen.get(key);
    if (!prev) { seen.set(key, p); continue; }
    if (!prev.abstract && p.abstract) prev.abstract = p.abstract;
    if (!prev.journal && p.journal) prev.journal = p.journal;
    prev.citation_count = Math.max(prev.citation_count, p.citation_count);
    prev.authors = prev.authors.length ? prev.authors : p.authors;
    prev.source = [prev.source, p.source].filter((s, i, a) => a.indexOf(s) === i).join("+");
  }
  return [...seen.values()];
}

// ── 交给 journal_rank.py 做四维评分排序（与技能完全一致）──
function rankPapers(papers: Paper[], opts: { topic: string; include?: string; secondary?: string; exclude?: string; topN: number }): any {
  const dir = mkdtempSync(join(tmpdir(), "jsearch-"));
  const inPath = join(dir, "input.json");
  const outPath = join(dir, "output.json");
  const args = [RANK_SCRIPT, "--input", inPath, "--output", outPath, "--topic", opts.topic, "--top-n", String(opts.topN)];
  for (const [flag, val] of [["--include-terms", opts.include], ["--secondary-terms", opts.secondary], ["--exclude-terms", opts.exclude]] as const) {
    if (val) args.push(flag, val);
  }
  try {
    writeFileSync(inPath, JSON.stringify({ results: papers, total: papers.length }, null, 2), "utf-8");
    const { cmd, args: runnerArgs } = resolvePythonRunner();
    const r = spawnSync(cmd, [...runnerArgs, ...args], { encoding: "utf-8", timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
    if (r.status !== 0 || r.error) {
      throw new Error(
        (r.error?.message ? `runner=${cmd} ${runnerArgs.join(" ")}: ${r.error.message}; ` : "") +
        (r.stderr?.slice(0, 500) || `rank script failed (exit ${r.status ?? "spawn error"})`)
      );
    }
    const ranked = JSON.parse(readFileSync(outPath, "utf-8"));
    ranked.results = ranked.results.map((p: any) => {
      const { _scores, _keyword_hits, ...rest } = p;
      return { ...rest, score: _scores?.total ?? 0, score_detail: _scores, keyword_hits: _keyword_hits };
    });
    return ranked;
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响结果 */ }
  }
}

function formatCitation(p: { authors?: string[]; year?: number | null; title?: string; journal?: string; doi?: string }): string {
  const authors = (p.authors || []).slice(0, 6).join(", ") + ((p.authors || []).length > 6 ? " et al." : "");
  const year = p.year ? ` (${p.year}).` : ".";
  return `${authors}${year} ${p.title || ""}. ${p.journal || ""}. DOI: ${p.doi || "—"}`;
}

export default function (pi: ExtensionAPI) {
  // ── journal_search：多源并发检索 + 期刊优先级排序 ──
  pi.registerTool({
    name: "journal_search",
    label: "Journal Search",
    description:
      "Priority-ranked literature search (rock mechanics & geotechnical). Searches CrossRef/OpenAlex/Semantic Scholar official APIs in parallel, " +
      "dedups by DOI, then ranks by the 26-journal tier list (tier 35 + citations 25 + recency 15 + keyword 25, via journal_rank.py). " +
      "Use for literature search within research scope; pass include_terms/secondary_terms/exclude_terms to tune ranking. " +
      "NOTE: query 是 API 检索串，不是排序关键词——只传 query 时 keyword 得分 0/25（仅按期刊+引用+时效排序）。要加权主题相关性，须另传 include_terms(+2)/secondary_terms(+1)/exclude_terms(-2)。",
    parameters: Type.Object({
      query: Type.String({ description: "Search keywords (space-separated; use quotes for exact phrases)" }),
      limit: Type.Optional(Type.Number({ default: 20, description: "每源抓取行数（总抓取 ≈ limit × 源数；范围 1-50）" })),
      top_n: Type.Optional(Type.Number({ default: 15, description: "去重+排序后最终返回数（范围 1-50）" })),
      year_from: Type.Optional(Type.Number({ description: "Only papers published from this year" })),
      sources: Type.Optional(Type.String({ default: "crossref,openalex,semantic_scholar", description: "逗号分隔源列表（'semantic' 是 'semantic_scholar' 的别名）" })),
      include_terms: Type.Optional(Type.String({ description: "Comma-separated strong keywords for ranking (+2 each)" })),
      secondary_terms: Type.Optional(Type.String({ description: "Comma-separated secondary keywords (+1 each)" })),
      exclude_terms: Type.Optional(Type.String({ description: "Comma-separated terms to penalize (-2 each)" })),
    }),
    execute: async (_id: string, params: {
      query: string; limit?: number; top_n?: number; year_from?: number;
      sources?: string; include_terms?: string; secondary_terms?: string; exclude_terms?: string;
    }) => {
      const q = params.query.trim();
      if (!q) return { content: [{ type: "text" as const, text: JSON.stringify({ status: "error", message: "query is required" }) }] };
      const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
      const topN = Math.min(Math.max(params.top_n ?? 15, 1), 50);
      const want = (params.sources || "crossref,openalex,semantic_scholar").split(",").map(s => s.trim()).filter(Boolean);

      const jobs: Array<[string, () => Promise<Paper[]>]> = [];
      if (want.includes("crossref")) jobs.push(["crossref", () => searchCrossRef(q, limit, params.year_from)]);
      if (want.includes("openalex")) jobs.push(["openalex", () => searchOpenAlex(q, limit, params.year_from)]);
      if (want.includes("semantic_scholar") || want.includes("semantic")) jobs.push(["semantic_scholar", () => searchSemanticScholar(q, limit, params.year_from)]);

      const settled = await Promise.allSettled(jobs.map(([, fn]) => fn()));
      const perSource: Record<string, { ok: boolean; count: number; error?: string }> = {};
      const lists: Paper[][] = [];
      jobs.forEach(([name], i) => {
        const r = settled[i];
        if (r.status === "fulfilled") { perSource[name] = { ok: true, count: r.value.length }; lists.push(r.value); }
        else perSource[name] = { ok: false, count: 0, error: String(r.reason).slice(0, 200) };
      });

      const merged = mergePapers(lists);
      if (merged.length === 0) {
        return { content: [{ type: "text" as const, text: JSON.stringify(
          { status: "no_results", query: q, per_source: perSource,
            hint: "Try broader keywords or drop year_from; per-source errors are reported above" }, null, 2) }] };
      }

      try {
        const ranked = rankPapers(merged, { topic: q, include: params.include_terms, secondary: params.secondary_terms, exclude: params.exclude_terms, topN });
        ranked.per_source = perSource;
        return { content: [{ type: "text" as const, text: JSON.stringify(ranked, null, 2) }] };
      } catch (e) {
        // 排序脚本失败 → 退回未排序合并结果（检索仍可用）
        return { content: [{ type: "text" as const, text: JSON.stringify({
          status: "unranked", query: q, per_source: perSource, rank_error: String(e).slice(0, 300),
          results: merged.slice(0, topN).map(p => ({ ...p, score: 0 })),
        }, null, 2) }] };
      }
    },
  });

  // ── get_paper_by_id：DOI / OpenAlex W-id / Semantic Scholar id → 详情 ──
  pi.registerTool({
    name: "get_paper_by_id",
    label: "Get Paper By ID",
    description:
      "Fetch paper details by identifier: DOI (10.xxxx/...), OpenAlex work id (W…), or Semantic Scholar paper id (40-hex / CorpusId:…). " +
      "Merges CrossRef + Semantic Scholar for DOIs. Returns record with citation.",
    parameters: Type.Object({
      id: Type.String({ description: "DOI, OpenAlex W-id, or Semantic Scholar paper id" }),
    }),
    execute: async (_id: string, params: { id: string }) => {
      const raw = params.id.trim();
      try {
        const isDoi = /^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/.test(raw);
        const isOpenAlex = /^W\d+$/.test(raw) || raw.includes("openalex.org");
        const isS2 = /^[0-9a-f]{40}$/.test(raw) || raw.startsWith("CorpusId:");

        let rec: (Paper & { citation: string }) | null = null;

        if (isDoi) {
          const [cr, s2] = await Promise.allSettled([
            fetchJson(`https://api.crossref.org/works/${encodeURIComponent(raw)}?mailto=${MAILTO}`),
            (() => { const h: Record<string, string> = {}; if (S2_KEY) h["x-api-key"] = S2_KEY;
              return fetchJson(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(raw)}?fields=title,authors,year,citationCount,venue,abstract,url,openAccessPdf`, h); })(),
          ]);
          const it = cr.status === "fulfilled" ? (cr.value?.message || {}) : {};
          const sp = s2.status === "fulfilled" ? (s2.value || {}) : {};
          rec = {
            title: (it.title || [])[0] || sp.title || "",
            abstract: stripTags(it.abstract) || sp.abstract || "",
            journal: (it["container-title"] || [])[0] || sp.venue || "",
            year: it.issued?.["date-parts"]?.[0]?.[0] ?? sp.year ?? null,
            citation_count: Math.max(it["is-referenced-by-count"] || 0, sp.citationCount || 0),
            doi: it.DOI || raw,
            url: it.URL || sp.openAccessPdf?.url || sp.url || `https://doi.org/${raw}`,
            authors: (it.author || []).map((a: any) => [a.given, a.family].filter(Boolean).join(" "))
              .concat((sp.authors || []).map((a: any) => a.name || "")).filter((x: string, i: number, arr: string[]) => x && arr.indexOf(x) === i),
            source: cr.status === "fulfilled" ? "crossref" : (s2.status === "fulfilled" ? "semantic_scholar" : "none"),
          };
        } else if (isOpenAlex) {
          const oid = raw.includes("openalex.org") ? raw.split("/").pop() : raw;
          const w = await fetchJson(`https://api.openalex.org/works/${oid}?mailto=${MAILTO}`);
          const doi = (w.doi || "").replace(/^https?:\/\/doi\.org\//i, "");
          rec = {
            title: w.title || "", abstract: invertIndex(w.abstract_inverted_index),
            journal: w.primary_location?.source?.display_name || "",
            year: w.publication_year ?? null, citation_count: w.cited_by_count || 0,
            doi, url: w.doi || (doi ? `https://doi.org/${doi}` : w.id || ""),
            authors: (w.authorships || []).map((a: any) => a.author?.display_name || "").filter(Boolean),
            source: "openalex",
          };
        } else if (isS2) {
          const h: Record<string, string> = {}; if (S2_KEY) h["x-api-key"] = S2_KEY;
          const p = await fetchJson(`https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(raw)}?fields=title,authors,year,citationCount,externalIds,venue,abstract,url,openAccessPdf`, h);
          rec = {
            title: p.title || "", abstract: p.abstract || "", journal: p.venue || "",
            year: p.year ?? null, citation_count: p.citationCount || 0,
            doi: p.externalIds?.DOI || "", url: p.openAccessPdf?.url || p.url || "",
            authors: (p.authors || []).map((a: any) => a.name || ""), source: "semantic_scholar",
          };
        } else {
          return { content: [{ type: "text" as const, text: JSON.stringify({ status: "error", message: `Unrecognized identifier: ${raw}`, hint: "Use DOI, OpenAlex W-id, or S2 id" }) }] };
        }

        rec!.citation = formatCitation(rec!);
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "ok", ...rec! }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "error", id: raw, message: String(e).slice(0, 300), hint: "确认 id 类型：DOI 10.xxxx/... / OpenAlex W-id (W123) / S2 id（40-hex 或 CorpusId:NNN；纯数字 S2 id 不会被自动识别，需加 CorpusId: 前缀）" }, null, 2) }] };
      }
    },
  });

  // ── get_citation：DOI → 格式化引用（CrossRef 内容协商，官方通道）──
  pi.registerTool({
    name: "get_citation",
    label: "Get Citation",
    description: "Format a citation for a DOI via CrossRef content negotiation (official). Returns {status, citation, doi} — citation 是 ONE 格式化串（含 authors/year/title/journal），不是分立字段；另有 doi。",
    parameters: Type.Object({
      doi: Type.String({ description: "DOI, e.g. 10.1007/s00603-020-02128-8" }),
    }),
    execute: async (_id: string, params: { doi: string }) => {
      const doi = params.doi.trim().replace(/^https?:\/\/doi\.org\//i, "");
      try {
        const r = await fetch(`https://doi.org/${encodeURIComponent(doi)}`, {
          headers: { Accept: "application/vnd.citationstyles.csl+json" },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const csl = await r.json();
        const authors = (csl.author || []).map((a: any) => [a.given, a.family].filter(Boolean).join(" ")).join(", ");
        const year = csl.issued?.["date-parts"]?.[0]?.[0] ?? "";
        const citation = `${authors} (${year}). ${csl.title || ""}. ${csl["container-title"] || ""}. https://doi.org/${doi}`;
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "ok", citation, doi }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "error", doi, message: String(e).slice(0, 300), hint: "确认 DOI 可解析（https://doi.org/<doi>）；CrossRef 内容协商对未注册/格式错误 DOI 可能 404" }, null, 2) }] };
      }
    },
  });

  // ── journal_tiers：26 刊分级表（供检索前查证 / 检索后解释排序）──
  pi.registerTool({
    name: "journal_tiers",
    label: "Journal Tiers",
    description: "Return the 26-journal subscription tier table (Tier 0-5 with scores), derived from the user's Zotero subscription list.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const data = JSON.parse(readFileSync(TIERS_JSON, "utf-8"));
        const tiers = Object.entries<any>(data.tiers || {}).map(([tierId, info]) => ({
          tier: Number(tierId), label: info.label, score: info.score,
          journals: (info.journals || []).map((j: any) => j.abbr || j.name),
        }));
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "ok", tiers }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "error", message: String(e).slice(0, 200), hint: "journal_tiers 数据缺失（<包根>/skills/journal-search/references/journal_tiers.json；单独部署时可用环境变量 JOURNAL_SKILL_DIR 指向技能目录）。恢复技能文件后再试" }) }] };
      }
    },
  });
}
