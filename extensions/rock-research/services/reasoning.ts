/**
 * Reasoning Service — research synthesis, gap analysis, hypothesis generation.
 *
 * Core pipeline:
 *   Question → Retrieval → Evidence → Conflict → Gap → Hypothesis
 *
 * Output is always structured with clear labeling:
 *   FACT / SYNTHESIS / INTERPRETATION / HYPOTHESIS / IDEA / UNVERIFIED
 */

import { ResearchRepository } from '../db/repository.ts';
import { EvidenceService } from './evidence.ts';
import { ConflictService } from './conflict.ts';

export interface ResearchSynthesis {
  topic: string;
  mode: 'fast' | 'normal' | 'deep';
  consensus: string[];
  conflicts: { claim_a: string; claim_b: string; possible_reasons: string[] }[];
  gaps: string[];
  hypotheses: { statement: string; testability: number }[];
  ideas: { text: string; novelty: number }[];
  label: 'FACT' | 'SYNTHESIS' | 'INTERPRETATION' | 'EXPLORATORY';
}

export class ReasoningService {
  private repo: ResearchRepository;
  private evidenceService: EvidenceService;
  private conflictService: ConflictService;

  constructor(repo: ResearchRepository) {
    this.repo = repo;
    this.evidenceService = new EvidenceService(repo);
    this.conflictService = new ConflictService(repo);
  }

  /**
   * Full research synthesis for a topic.
   * Mode controls depth: fast=memory+top, normal=verify+conflict, deep=multi-round.
   */
  synthesize(topic: string, projectId?: number, mode: 'fast' | 'normal' | 'deep' = 'normal'): ResearchSynthesis {
    const claims = this.repo.searchClaims(topic, projectId);
    const claimIds = claims.map(c => c.id);

    // 每个 claim 只记一次权重判定（consensus/gaps 两轮共用，避免重复调用）
    const verdicts = new Map<number, string>();
    for (const claim of claims) {
      verdicts.set(claim.id, this.evidenceService.weighEvidence(claim.id).verdict);
    }

    // Consensus: claims with strong support and no contradictions
    const consensus: string[] = [];
    for (const claim of claims.slice(0, 10)) {
      if (verdicts.get(claim.id) === 'VERIFIED') {
        consensus.push(claim.text);
      }
    }

    // Conflicts
    const conflictCluster = this.conflictService.buildConflictCluster(claimIds, topic);
    const conflicts: { claim_a: string; claim_b: string; possible_reasons: string[] }[] = [];
    for (const rel of conflictCluster.relations) {
      if (rel.relation === 'contradicts') {
        const src = this.repo.getClaim(rel.source_id);
        const tgt = this.repo.getClaim(rel.target_id);
        if (src && tgt) {
          conflicts.push({
            claim_a: src.text,
            claim_b: tgt.text,
            possible_reasons: conflictCluster.possible_reasons,
          });
        }
      }
    }

    // Gaps: claims with insufficient evidence
    const gaps: string[] = [];
    for (const claim of claims) {
      const v = verdicts.get(claim.id);
      if (v === 'NO_LOCAL_EVIDENCE' || v === 'UNVERIFIED') {
        gaps.push(claim.text);
      }
    }

    // Hypotheses and ideas from database
    const ideas = this.repo.searchIdeas(topic, projectId);
    const finalIdeas = ideas.map(i => ({ text: i.text, novelty: i.novelty }));

    const hypotheses = this.repo.getHypothesesByProject(projectId || 0)
      .filter(h => h.status === 'proposed' || h.status === 'in_design');

    const finalHypotheses = hypotheses.map(h => ({
      statement: h.statement,
      testability: h.falsification ? 0.8 : 0.4,
    }));

    // Label the output appropriately
    let label: ResearchSynthesis['label'] = 'SYNTHESIS';
    if (consensus.length > 0 && conflicts.length === 0 && gaps.length === 0) label = 'FACT';
    else if (conflicts.length > 0 || gaps.length > 0) label = 'INTERPRETATION';
    if (mode === 'deep') {
      // DEEP mode adds hypothesis generation
      if (finalHypotheses.length === 0 && gaps.length > 0) {
        finalHypotheses.push({
          statement: `Based on identified gaps in "${topic}", further targeted experiments are needed.`,
          testability: 0.5,
        });
      }
    }

    return {
      topic,
      mode,
      consensus,
      conflicts,
      gaps,
      hypotheses: finalHypotheses,
      ideas: finalIdeas,
      label,
    };
  }

  /**
   * Generate research gaps from claims and conflicts.
   * Uses contradiction-driven and evidence-driven gap detection.
   */
  identifyGaps(topic: string, projectId?: number): string[] {
    const claims = this.repo.searchClaims(topic, projectId);
    const gaps: string[] = [];

    // Gap type 1: conflicting claims without resolution
    const conflicts = this.conflictService.findEvidenceConflicts(projectId);
    for (const c of conflicts) {
      const src = this.repo.getClaim(c.source_id);
      const tgt = this.repo.getClaim(c.target_id);
      if (src && tgt) {
        gaps.push(`Conflict between: "${src.text.substring(0, 80)}..." and "${tgt.text.substring(0, 80)}..." — underlying mechanism unclear`);
      }
    }

    // Gap type 2: claims with no local evidence
    for (const claim of claims) {
      const v = this.evidenceService.weighEvidence(claim.id);
      if (v.verdict === 'NO_LOCAL_EVIDENCE') {
        gaps.push(`Claim lacks supporting evidence: "${claim.text.substring(0, 80)}..."`);
      }
    }

    // Gap type 3: well-established consensus → what's the next question
    const verified = claims.filter(c => {
      const v = this.evidenceService.weighEvidence(c.id);
      return v.verdict === 'VERIFIED';
    });
    if (verified.length >= 3 && claims.length <= 5) {
      gaps.push(`Well-established findings exist (${verified.length} verified claims). Boundary conditions and unexplored parameter ranges remain open.`);
    }

    return [...new Set(gaps)];
  }
}