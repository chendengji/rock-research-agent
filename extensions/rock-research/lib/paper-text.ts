/**
 * paper-text.ts — 论文原文访问与定位助手。
 *
 * 唯一可信原文来源：paper-raw/<name>.json 的 pages[].text（parse_pdf.py 产物）。
 * 用途：claim_verify 回原文接地——
 *   - 给定 evidence.file_path + page + text_span，定位 span 真实出现在哪一页；
 *   - 给定一段 RAG chunk 文本，找到它所属的页与原文窗口。
 *
 * 关键事实（实测）：extract_claims_llm.py 的 text_span 不是逐字 quote，
 * 而是 LLM 轻度改写/合并的句子（token 召回率 ~0.95 但非子串）。
 * 因此定位用模糊 token 重叠，而非严格子串——否则真证据会被误判 BROKEN_CITATION。
 */

import { readFileSync, existsSync } from "fs";

export interface ParsedPage {
  number: number;
  text: string;
  [k: string]: unknown;
}

export interface ParsedDocument {
  file_path?: string;
  title?: string;
  authors?: string;
  abstract?: string;
  pages?: ParsedPage[];
  num_pages?: number;
  [k: string]: unknown;
}

export interface SpanMatch {
  /** span 是否真实存在于论文某页（bestPageRecall >= FOUND_THRESHOLD） */
  found: boolean;
  /** 引用所标页面上 span 的 token 召回率 */
  citedPageRecall: number;
  /** 全篇召回率最高的页码 */
  bestPage: number | null;
  /** 最高召回率 */
  bestPageRecall: number;
  /** bestPage 上围绕 span 的原文窗口（≤ ~600 字），供 LLM 判官比对 */
  matchedText: string | null;
}

/** BROKEN_CITATION 阈值：召回率低于此值认为引用是幻觉（原文不存在） */
export const BROKEN_THRESHOLD = 0.3;
/** SPAN_CONFIRMED 阈值：召回率达到此值认为引用真实存在 */
export const FOUND_THRESHOLD = 0.5;

/** 折叠所有空白（含换行）为单空格并 trim */
export function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 词集（用于重叠）。
 *  拉丁/数字：≥2 字符连续片段；CJK：无空格，取重叠 bigram（结构面→{结构,构面,面倾,…}）。
 *  这样中英 span↔text 的召回率都有意义，不依赖分词器。 */
export function tokenSet(s: string): Set<string> {
  const n = normalize(s).toLowerCase();
  const set = new Set<string>();
  for (const m of n.matchAll(/[a-z0-9]{2,}/g)) set.add(m[0]);
  const cjk = [...n.matchAll(/[一-鿿]/g)].map(m => m[0]);
  for (let i = 0; i + 1 < cjk.length; i++) set.add(cjk[i] + cjk[i + 1]);
  return set;
}

/** span 对 text 的 token 召回率（span 中有多少词出现在 text 里） */
export function recall(spanTokens: Set<string>, text: string): number {
  if (spanTokens.size === 0) return 0;
  const txt = tokenSet(text);
  let hit = 0;
  for (const t of spanTokens) if (txt.has(t)) hit++;
  return hit / spanTokens.size;
}

/**
 * 把 evidence.file_path（可能是 .pdf/.json/裸名）解析为可读的 .json 路径。
 * 实测存库的 file_path 多为 .json；schema 注释虽写 "PDF path" 但数据以 .json 为主。
 */
export function resolvePaperJson(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  // 去掉已知后缀得 base（fulltext.json 须先于 json 匹配，否则 .json$ 会吃掉 .fulltext.json）
  const base = filePath.replace(/\.(fulltext\.json|json|pdf)$/i, "");
  // 1. 优先 .fulltext.json：parse_pdf.py 全文解析产物，含 pages[].text。
  //    绝不能先返回 classify_papers.py 的小 .json（仅分类元数据、无 pages），
  //    否则 locateSpan 遍历空 pages → 召回 0 → 误判 BROKEN_CITATION（把真证据当幻觉）。
  const ft = base + ".fulltext.json";
  if (existsSync(ft)) return ft;
  // 2. 直接传 .json 且存在（仅当该篇无 fulltext 版时落到此；可能是分类元数据，无 pages）
  if (filePath.endsWith(".json") && existsSync(filePath)) return filePath;
  // 3. .pdf → .json（无 fulltext 版的退化）
  const asJson = filePath.replace(/\.pdf$/i, ".json");
  if (existsSync(asJson)) return asJson;
  if (!filePath.endsWith(".pdf") && existsSync(filePath)) return filePath;
  return null;
}

/** 加载论文 ParsedDocument；失败返回 null */
export function loadPaper(filePath: string | null | undefined): ParsedDocument | null {
  const p = resolvePaperJson(filePath);
  if (!p) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as ParsedDocument;
  } catch {
    return null;
  }
}

/** 取指定页码的原文 */
export function getPageText(doc: ParsedDocument, page: number | null): string | null {
  if (!doc.pages || page == null) return null;
  const p = doc.pages.find(x => x.number === page);
  return p ? p.text : null;
}

/**
 * 模糊定位 text_span：在论文各页中找召回率最高的页。
 * 用于接地链第 3 步——确认抽取器写的引用真的来自这篇论文、且页码对。
 */
export function locateSpan(doc: ParsedDocument, span: string, citedPage: number | null): SpanMatch {
  const spanTokens = tokenSet(span);
  if (spanTokens.size === 0) {
    return { found: false, citedPageRecall: 0, bestPage: null, bestPageRecall: 0, matchedText: null };
  }
  const citedPageRecall = recall(spanTokens, getPageText(doc, citedPage) ?? "");
  let bestPage: number | null = null;
  let bestPageRecall = 0;
  let bestText = "";
  for (const p of doc.pages || []) {
    const r = recall(spanTokens, p.text);
    if (r > bestPageRecall) {
      bestPageRecall = r;
      bestPage = p.number;
      bestText = p.text;
    }
  }
  return {
    found: bestPageRecall >= FOUND_THRESHOLD,
    citedPageRecall,
    bestPage,
    bestPageRecall,
    matchedText: bestText ? windowText(bestText, span) : null,
  };
}

/** 在 text 中找到与 anchor 最长公共 n-gram，返回其周围 ≤600 字窗口。
 *  找不到公共片段则返回 text 首 400 字。供 LLM 判官拿"真实原文段"用。 */
export function windowText(text: string, anchor: string): string {
  const ntext = normalize(text);
  const nanchor = normalize(anchor);
  const anchorWords = nanchor.split(" ").filter(Boolean);
  for (let len = Math.min(anchorWords.length, 8); len >= 3; len--) {
    for (let i = 0; i + len <= anchorWords.length; i++) {
      const gram = anchorWords.slice(i, i + len).join(" ");
      const idx = ntext.indexOf(gram);
      if (idx >= 0) {
        const start = Math.max(0, idx - 100);
        const end = Math.min(ntext.length, idx + gram.length + 400);
        return (start > 0 ? "…" : "") + ntext.slice(start, end) + (end < ntext.length ? "…" : "");
      }
    }
  }
  return ntext.slice(0, 400) + (ntext.length > 400 ? "…" : "");
}

/**
 * 给定一段 RAG chunk 文本（可能是 JSON 片段，含 key/标点噪声），
 * 在论文各页中找召回率最高的页——用于无靶 RAG 模式的页定位。
 * 返回 {page, text, recall}；bestRecall==0 表示找不到归属页。
 */
export function locateChunkPage(
  doc: ParsedDocument,
  chunkContent: string,
): { page: number | null; text: string; recall: number } {
  const chunkTokens = tokenSet(stripJsonNoise(chunkContent));
  if (chunkTokens.size === 0) return { page: null, text: "", recall: 0 };
  let bestPage: number | null = null;
  let bestRecall = 0;
  let bestText = "";
  for (const p of doc.pages || []) {
    const r = recall(chunkTokens, p.text);
    if (r > bestRecall) {
      bestRecall = r;
      bestPage = p.number;
      bestText = p.text;
    }
  }
  return { page: bestPage, text: bestText, recall: bestRecall };
}

/** 从 RAG chunk_content（JSON 片段）里剥离 JSON 语法噪声，留下更像原文的词 */
function stripJsonNoise(s: string): string {
  return s
    .replace(/"[^"]+"\s*:/g, " ") // JSON key:
    .replace(/["{}\[\],]/g, " ")
    .replace(/\\n/g, " ");
}
