/**
 * Conflict Service — detect and analyze claim conflicts.
 *
 * Relations: supports / contradicts / qualifies / refines / supersedes
 *
 * The service does NOT force consensus. It surfaces disagreement
 * so the researcher (and LLM) can reason about why claims conflict.
 */

import { ResearchRepository, type ClaimRelation } from '../db/repository.ts';
import { EvidenceService } from './evidence.ts';

export interface ConflictCluster {
  topic: string;
  claim_ids: number[];
  relations: ClaimRelation[];
  support_balance: { for: number; against: number };
  possible_reasons: string[];
}

export class ConflictService {
  private repo: ResearchRepository;
  private evidenceService: EvidenceService;

  constructor(repo: ResearchRepository) {
    this.repo = repo;
    this.evidenceService = new EvidenceService(repo);
  }

  /**
   * Find all direct contradictions involving a claim.
   */
  findDirectConflicts(claimId: number): ClaimRelation[] {
    return this.repo.getClaimRelations(claimId)
      .filter(r => r.relation === 'contradicts');
  }

  /**
   * Find indirect conflicts: claims on the same topic with contradictory evidence.
   */
  findEvidenceConflicts(projectId?: number): ClaimRelation[] {
    return this.repo.getConflictingClaims(projectId);
  }

  /**
   * Build a conflict cluster: claims with contradicting evidence on a topic.
   * Identifies possible methodological reasons for the conflict.
   */
  buildConflictCluster(claimIds: number[], topic: string): ConflictCluster {
    const relations: ClaimRelation[] = [];
    for (const cid of claimIds) {
      const rels = this.repo.getClaimRelations(cid);
      relations.push(...rels.filter(r => claimIds.includes(r.target_id) || claimIds.includes(r.source_id)));
    }

    const strengths = this.evidenceService.aggregateEvidenceStrength(claimIds);
    let support_for = 0, support_against = 0;
    for (const [cid, s] of strengths) {
      const net = s.support - s.contradict;
      if (net > 0) support_for += net;
      else support_against += Math.abs(net);
    }

    // Common reasons for rock mechanics conflicts
    const possible_reasons: string[] = [];
    if (relations.some(r => r.relation === 'contradicts')) {
      possible_reasons.push('Different stress paths / loading conditions');
      possible_reasons.push('Different rock types or specimen scales');
      possible_reasons.push('Different failure criteria used for interpretation');
      possible_reasons.push('Different confining pressure ranges');
    }
    if (relations.some(r => r.relation === 'qualifies')) {
      possible_reasons.push('Findings are conditional on specific boundary conditions');
    }

    // Deduplicate
    const uniqueReasons = [...new Set(possible_reasons)];

    return {
      topic,
      claim_ids: claimIds,
      relations,
      support_balance: { for: support_for, against: support_against },
      possible_reasons: uniqueReasons,
    };
  }

  /**
   * Summarize conflict: does the field agree, disagree, or is it unresolved?
   */
  summarizeStatus(cluster: ConflictCluster): 'CONSENSUS' | 'CONTESTED' | 'INSUFFICIENT_EVIDENCE' {
    const total = cluster.support_balance.for + cluster.support_balance.against;
    if (total < 0.5) return 'INSUFFICIENT_EVIDENCE';
    const ratio = cluster.support_balance.for / Math.max(total, 0.01);
    if (ratio > 0.8) return 'CONSENSUS';
    return 'CONTESTED';
  }
}