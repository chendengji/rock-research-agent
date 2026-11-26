/**
 * Evidence Service — collect, verify, and grade evidence provenance.
 *
 * Core principle:
 *   Claim → Evidence → Paper → Page → Actual Text → Supports/Contradicts
 *
 * 两条验证路径：
 *   - verify()              — 库内权重累加（抽取时写死的 strength 重算）。
 *                              用于 conflict/reasoning 聚合，不回原文，是"循环确认"。
 *   - verifyAgainstSource() — 真正回原文接地的 5 步链：
 *                              取段 → 页定位 → 反幻觉 → LLM 蕴含 → 判 CORRECT/MISATTRIBUTED。
 *                              Model internal knowledge 不作为已验证证据。
 */

import { ResearchRepository, type Claim, type Evidence } from '../db/repository.ts';
import { loadPaper, locateSpan, locateChunkPage, windowText, getPageText, tokenSet, recall, BROKEN_THRESHOLD, FOUND_THRESHOLD } from '../lib/paper-text.ts';
import { ragSearch, type RagHit } from '../lib/rag-search.ts';
import { entail, sensenovaAvailable, SENSENOVA_MODEL, type EntailLabel } from '../lib/sensenova.ts';

export type Verdict =
  | 'VERIFIED'
  | 'PARTIALLY_SUPPORTED'
  | 'CONTRADICTED'
  | 'UNVERIFIED'
  | 'NO_LOCAL_EVIDENCE';

export interface VerificationResult {
  claim_id: number;
  claim_text: string;
  verdict: Verdict;
  evidence: Evidence[];
  support_score: number;
  contradict_score: number;
  provenance: { paper_path: string | null; page: number | null; section: string | null }[];
}

export interface MatchedPassage {
  file_path: string;
  page: number | null;
  text_span: string | null;     // 真实原文窗口（供审计/LLM 比对）
  score?: number;                // RAG hybrid 分（无靶）或 token 召回率（有靶 span）
  entailment?: EntailLabel;
  entailment_reason?: string;
}

export interface VerifyOptions {
  claim_text: string;
  claim_id?: number;             // 模式 1：验已存 claim 的存储引用（TARGETED_SPAN）
  cited_file?: string;           // 模式 2：claim 引用了某指定论文（TARGETED_FILE）
  project_id?: number;
  use_llm?: boolean;             // 默认 auto：sensenovaAvailable()。false=仅结构接地（Phase 1/2）
  top_k?: number;                // 无靶 RAG 命中数，默认 5
}

export interface SourceVerification {
  claim_text: string;
  claim_id: number | null;
  verdict: string;               // CORRECT|MISATTRIBUTED|BROKEN_CITATION|PAGE_MISATTRIBUTED|SPAN_CONFIRMED|SUPPORTED_BY|CONTRADICTED_BY|NO_SUPPORT_FOUND|...
  mode: "TARGETED_SPAN" | "TARGETED_FILE" | "UNGUIDED";
  cited_source: { file_path: string | null; page: number | null } | null;
  matched_passages: MatchedPassage[];
  judge_model: string | null;    // LLM 判官模型名，未启用 LLM 时为 null
  notes?: string;
}

export class EvidenceService {
  private repo: ResearchRepository;

  constructor(repo: ResearchRepository) {
    this.repo = repo;
  }

  /**
   * 按权重聚合单条 claim 的证据（库内累加 strength，不回原文）。
   * 用于 conflict/reasoning 聚合判定 CONSENSUS/CONTESTED，不用于引用接地。
   * 引用接地（回原文 5 步链）见 verifyAgainstSource()。
   */
  weighEvidence(claimId: number): VerificationResult {
    const claim = this.repo.getClaim(claimId);
    if (!claim) throw new Error(`Claim ${claimId} not found`);

    const evidence = this.repo.getEvidenceForClaim(claimId);
    let support_score = 0;
    let contradict_score = 0;

    for (const ev of evidence) {
      if (ev.evidence_type === 'contradicting') contradict_score += ev.strength;
      else if (ev.evidence_type === 'direct') support_score += ev.strength * 1.2;
      else if (ev.evidence_type === 'supporting') support_score += ev.strength;
      else support_score += ev.strength * 0.5; // indirect / contextual
    }

    let verdict: Verdict;
    if (evidence.length === 0) verdict = 'NO_LOCAL_EVIDENCE';
    else if (contradict_score > support_score * 1.5) verdict = 'CONTRADICTED';
    else if (support_score > 1.0 && support_score > contradict_score * 2) verdict = 'VERIFIED';
    else if (support_score > 0) verdict = 'PARTIALLY_SUPPORTED';
    else verdict = 'UNVERIFIED';

    return {
      claim_id: claim.id,
      claim_text: claim.text,
      verdict,
      evidence,
      support_score,
      contradict_score,
      provenance: evidence.map(e => ({
        paper_path: e.file_path,
        page: e.page,
        section: e.section,
      })),
    };
  }

  /**
   * Collect aggregated evidence strength for a set of claims.
   * Used by conflict analysis and research synthesis.
   */
  aggregateEvidenceStrength(claimIds: number[]): Map<number, { support: number; contradict: number; total: number }> {
    const result = new Map<number, { support: number; contradict: number; total: number }>();
    for (const cid of claimIds) {
      const v = this.weighEvidence(cid);
      result.set(cid, {
        support: v.support_score,
        contradict: v.contradict_score,
        total: v.evidence.length,
      });
    }
    return result;
  }

  // ── 引用接地验证（5 步链）──
  // verify() 是库内权重累加（不回原文，循环确认）；
  // verifyAgainstSource() 才真正回原文：取段→定位→反幻觉→LLM 蕴含→判，
  // 并把结果落 claim_verifications（可审计闭环，evidence_trace 可回溯）。
  async verifyAgainstSource(opts: VerifyOptions): Promise<SourceVerification> {
    const result = await this._verify(opts);
    // 持久化验证历史（失败不阻断返回结果）
    try {
      this.repo.saveVerification({
        claim_id: result.claim_id,
        claim_text: result.claim_text,
        verdict: result.verdict,
        mode: result.mode,
        cited_file: result.cited_source?.file_path ?? null,
        cited_page: result.cited_source?.page ?? null,
        judge_model: result.judge_model,
        matched: result.matched_passages,
        notes: result.notes,
      });
    } catch { /* 持久化失败不影响验证结果 */ }
    return result;
  }

  private async _verify(opts: VerifyOptions): Promise<SourceVerification> {
    const useLlm = opts.use_llm ?? sensenovaAvailable();
    const projectRoot = process.env.ROCK_PROJECT_ROOT || process.cwd();
    const result: SourceVerification = {
      claim_text: opts.claim_text,
      claim_id: opts.claim_id ?? null,
      verdict: "UNVERIFIED",
      mode: "UNGUIDED",
      cited_source: null,
      matched_passages: [],
      judge_model: useLlm ? SENSENOVA_MODEL : null,
    };

    // ── 模式 1：TARGETED_SPAN（验已存 claim 的存储引用）──
    if (opts.claim_id) {
      const claim = this.repo.getClaim(opts.claim_id);
      if (!claim) { result.verdict = "CLAIM_NOT_FOUND"; return result; }
      result.claim_text = claim.text;
      result.mode = "TARGETED_SPAN";
      const evs = this.repo.getEvidenceForClaim(opts.claim_id);
      if (evs.length === 0) {
        // claim 无存储引用 → 降级无靶 RAG
        result.notes = "claim 无存储 evidence，降级无靶 RAG 检索";
        return this.verifyUnguided(claim.text, projectRoot, opts.top_k ?? 5, useLlm, result);
      }
      const ev = evs[0]; // strength DESC 首条
      result.cited_source = { file_path: ev.file_path, page: ev.page };
      if (!ev.file_path) {
        result.verdict = "SOURCE_NOT_FOUND";
        result.notes = "该 claim 的 evidence 没有存 file_path（claim_save 时未附源文件）；无法回原文接地——重新保存 claim 并附带 ev_file_path/ev_text_span，或核对 evidence 表";
        return result;
      }
      const doc = loadPaper(ev.file_path);
      if (!doc) {
        result.verdict = "SOURCE_NOT_FOUND";
        result.notes = `无法打开解析缓存 ${ev.file_path}（.json 不在 paper-raw/？）`;
        return result;
      }
      // 有 text_span → 常规 span 召回定位；无 text_span（claim_save 允许只附文件）→
      // 以 claim 文本自身对所引页做召回率预检 + 页面窗口，避免空 span 被误判 BROKEN_CITATION
      const spanSource = (ev.text_span || "").trim();
      const m = spanSource
        ? locateSpan(doc, spanSource, ev.page)
        : (() => {
            const pageText = getPageText(doc, ev.page) ?? "";
            const r = recall(tokenSet(claim.text), pageText);
            return { found: r >= FOUND_THRESHOLD, citedPageRecall: r, bestPage: ev.page,
              bestPageRecall: r, matchedText: pageText ? windowText(pageText, claim.text) : null };
          })();
      // 第 3 步：反幻觉——引用 span 真的来自这篇论文吗
      if (m.bestPageRecall < BROKEN_THRESHOLD) {
        result.verdict = "BROKEN_CITATION";
        result.notes = `引用 span 在源文召回率仅 ${m.bestPageRecall.toFixed(2)}（< ${BROKEN_THRESHOLD}），疑为抽取器幻觉`;
        result.matched_passages = [{
          file_path: ev.file_path!, page: m.bestPage,
          text_span: m.matchedText, score: Number(m.bestPageRecall.toFixed(3)),
        }];
        return result; // BROKEN 无需 LLM 比对
      }
      const passage: MatchedPassage = {
        file_path: ev.file_path!, page: m.bestPage ?? ev.page,
        text_span: m.matchedText, score: Number(m.bestPageRecall.toFixed(3)),
      };
      // 第 4 步：LLM 蕴含——claim 与真实原文段比对
      if (useLlm && m.matchedText) {
        try {
          const er = await entail(claim.text, m.matchedText);
          passage.entailment = er.label;
          passage.entailment_reason = er.reason;
          result.verdict = er.label === "SUPPORTS" ? "CORRECT" : "MISATTRIBUTED";
        } catch (e: any) {
          result.verdict = m.citedPageRecall < BROKEN_THRESHOLD ? "PAGE_MISATTRIBUTED" : "SPAN_CONFIRMED";
          result.notes = `LLM 判定失败（${e.message}），降级结构判定`;
        }
      } else {
        result.verdict = m.citedPageRecall < BROKEN_THRESHOLD ? "PAGE_MISATTRIBUTED" : "SPAN_CONFIRMED";
        if (!useLlm) result.notes = "未启用 LLM 判官（仅结构接地，未做语义比对）";
      }
      if (!spanSource) {
        result.notes = (result.notes ? result.notes + "；" : "") + "evidence 未存 text_span，仅页面级接地（以 claim 文本对所引页召回率预检）";
      }
      result.matched_passages = [passage];
      return result;
    }

    // ── 模式 2：TARGETED_FILE（claim 引用了某指定论文）──
    if (opts.cited_file) {
      result.mode = "TARGETED_FILE";
      result.cited_source = { file_path: opts.cited_file, page: null };
      const hits = await ragSearch(opts.claim_text, projectRoot, opts.top_k ?? 10);
      const want = opts.cited_file.replace(/\.json$/, "");
      const fileHits = hits.filter(h => h.file.replace(/\.json$/, "") === want);
      if (fileHits.length === 0) {
        result.verdict = "NO_SUPPORT_FOUND";
        result.notes = "所引论文在 RAG 无命中（未索引或与 claim 无关）；需 rag-rebuild 重建该论文索引";
        return result;
      }
      return this.judgeFromHits(opts.claim_text, fileHits, useLlm, result);
    }

    // ── 模式 3：UNGUIDED（纯 claim_text，全库 RAG）──
    return this.verifyUnguided(opts.claim_text, projectRoot, opts.top_k ?? 5, useLlm, result);
  }

  /** 无靶 RAG 验证：claim_text → 全库检索 → 页定位 → LLM 蕴含 */
  private async verifyUnguided(
    claimText: string, projectRoot: string, topK: number,
    useLlm: boolean, result: SourceVerification,
  ): Promise<SourceVerification> {
    result.mode = "UNGUIDED";
    const hits = await ragSearch(claimText, projectRoot, topK);
    if (hits.length === 0) {
      result.verdict = "NO_SUPPORT_FOUND";
      result.notes = "RAG 无命中（项目无 .pi/rag/rag.db 或索引为空）";
      return result;
    }
    return this.judgeFromHits(claimText, hits, useLlm, result);
  }

  /** 对 RAG hits 做页定位 + LLM 判定，产出 SUPPORTED_BY / CONTRADICTED_BY / NO_SUPPORT_FOUND */
  private async judgeFromHits(
    claimText: string, hits: RagHit[],
    useLlm: boolean, result: SourceVerification,
  ): Promise<SourceVerification> {
    const passages: MatchedPassage[] = [];
    for (const h of hits.slice(0, 3)) {
      const doc = loadPaper(h.file);
      if (!doc) {
        passages.push({ file_path: h.file, page: null, text_span: h.content.slice(0, 400), score: h.score });
        continue;
      }
      const loc = locateChunkPage(doc, h.content);
      passages.push({
        file_path: h.file, page: loc.page,
        text_span: loc.text ? windowText(loc.text, h.content).slice(0, 600) : h.content.slice(0, 400),
        score: h.score,
      });
    }
    result.matched_passages = passages;
    if (passages.length === 0) { result.verdict = "NO_SUPPORT_FOUND"; return result; }
    const top = passages[0];
    if (!top.text_span) { result.verdict = "NO_SUPPORT_FOUND"; return result; }
    if (!useLlm) {
      result.verdict = (top.score ?? 0) >= 0.3 ? "SUPPORTED_BY" : "NO_SUPPORT_FOUND";
      result.notes = "未启用 LLM 判官（仅 RAG 相似度，不作语义接地）";
      return result;
    }
    try {
      const er = await entail(claimText, top.text_span);
      top.entailment = er.label;
      top.entailment_reason = er.reason;
      result.verdict = er.label === "SUPPORTS" ? "SUPPORTED_BY"
        : er.label === "CONTRADICTS" ? "CONTRADICTED_BY" : "NO_SUPPORT_FOUND";
    } catch (e: any) {
      result.verdict = (top.score ?? 0) >= 0.3 ? "SUPPORTED_BY" : "NO_SUPPORT_FOUND";
      result.notes = `LLM 判定失败（${e.message}），降级 RAG 相似度`;
    }
    return result;
  }
}