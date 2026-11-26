/**
 * Evolution Service — track how claims change over time.
 *
 * A claim can be:
 *  - Superseded by newer evidence
 *  - Refined (narrower scope, higher precision)
 *  - Retracted (proven wrong)
 *
 * Every state transition is logged with timestamps and the
 * evidence that caused the change.
 */

import { ResearchRepository, type Claim } from '../db/repository.ts';
import { EvidenceService, type Verdict } from './evidence.ts';

export interface EvolutionStep {
  from_claim_id: number | null;
  to_claim_id: number | null;
  relation: 'supersedes' | 'refines' | 'retracts' | 'qualifies';
  triggered_by_evidence_id: number | null;
  timestamp: string;
}

export interface ClaimEvolution {
  claim_id: number;
  history: EvolutionStep[];
  current_verdict: Verdict;
  age_days: number;
}

export class EvolutionService {
  private repo: ResearchRepository;
  private evidenceService: EvidenceService;

  constructor(repo: ResearchRepository) {
    this.repo = repo;
    this.evidenceService = new EvidenceService(repo);
  }

  /**
   * Get the full evolution chain for a claim.
   * Traces: what came before, what supersedes it, what refines it.
   */
  getEvolution(claimId: number): ClaimEvolution | null {
    const claim = this.repo.getClaim(claimId);
    if (!claim) return null;

    const history: EvolutionStep[] = [];

    // Find what this claim supersedes (backward)
    if (claim.supersedes_id) {
      const superseded = this.repo.getClaim(claim.supersedes_id);
      if (superseded) {
        history.push({
          from_claim_id: superseded.id,
          to_claim_id: claim.id,
          relation: 'supersedes',
          triggered_by_evidence_id: null,
          timestamp: claim.created_at,
        });
      }
    }

    // Find what supersedes this claim (forward) — 精确查 supersedes_id
    const supersededBy = this.repo.getSupersedingClaims(claimId);
    for (const sc of supersededBy) {
      history.push({
        from_claim_id: claim.id,
        to_claim_id: sc.id,
        relation: 'supersedes',
        triggered_by_evidence_id: null,
        timestamp: sc.created_at,
      });
    }

    // Find refinement relations
    const relations = this.repo.getClaimRelations(claimId);
    for (const rel of relations) {
      if (['refines', 'qualifies'].includes(rel.relation)) {
        history.push({
          from_claim_id: rel.source_id,
          to_claim_id: rel.target_id,
          relation: rel.relation as any,
          triggered_by_evidence_id: null,
          timestamp: rel.created_at,
        });
      }
    }

    const ageMs = Date.now() - new Date(claim.created_at).getTime();
    const ageDays = Math.floor(ageMs / 86400000);

    return {
      claim_id: claimId,
      history,
      current_verdict: this.evidenceService.weighEvidence(claimId).verdict,
      age_days: ageDays,
    };
  }

  /**
   * Supersede an old claim with a new one.
   * Links old → new and marks old as superseded.
   */
  supersede(oldClaimId: number, newClaimText: string, projectId?: number, evidenceId?: number): Claim {
    const old = this.repo.getClaim(oldClaimId);
    if (!old) throw new Error(`Claim ${oldClaimId} not found`);

    // Create new claim superseding old
    const newClaim = this.repo.createClaim({
      project_id: projectId || old.project_id || undefined,
      text: newClaimText,
      claim_type: old.claim_type || undefined,
      confidence: old.confidence,
      supersedes_id: oldClaimId,
    });

    // Mark old as superseded
    this.repo.updateClaimStatus(oldClaimId, 'superseded');

    // Record relation
    this.repo.addClaimRelation(oldClaimId, newClaim.id, 'supersedes',
      `Superseded by new evidence (evidence_id: ${evidenceId || 'N/A'})`);

    return newClaim;
  }
}