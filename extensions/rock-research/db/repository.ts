import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { readFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';

// ---- Types ----

export interface Project {
  id: number;
  name: string;
  description: string | null;
  status: 'active' | 'archived' | 'completed';
  created_at: string;
  updated_at: string;
}

export interface Claim {
  id: number;
  project_id: number | null;
  text: string;
  claim_type: string | null;
  status: 'active' | 'superseded' | 'retracted' | 'disputed';
  confidence: number;
  evidence_strength: number;
  contradiction_level: number;
  novelty: number;
  testability: number;
  source_tier: number;
  valid_from: string;
  valid_to: string | null;
  supersedes_id: number | null;
  superseded_by: number | null;
  created_at: string;
}

export interface Evidence {
  id: number;
  claim_id: number;
  paper_id: number | null;
  source_type: string | null;
  file_path: string | null;
  page: number | null;
  section: string | null;
  text_span: string | null;
  evidence_type: 'direct' | 'supporting' | 'contradicting' | 'indirect' | 'contextual';
  strength: number;
  created_at: string;
}

export interface ClaimRelation {
  source_id: number;
  target_id: number;
  relation: string;
  rationale: string | null;
  created_at: string;
}

export interface Idea {
  id: number;
  project_id: number | null;
  text: string;
  source_claims: string | null;
  rationale: string | null;
  novelty: number;
  plausibility: number;
  status: string;
  created_at: string;
}

export interface Hypothesis {
  id: number;
  idea_id: number | null;
  project_id: number | null;
  statement: string;
  prediction: string | null;
  observable: string | null;
  experiment: string | null;
  falsification: string | null;
  status: 'proposed' | 'in_design' | 'testing' | 'supported' | 'falsified' | 'abandoned';
  created_at: string;
  updated_at: string;
}

// ---- Repository ----

export class ResearchRepository {
  private db: Database.Database;

  /**
   * 数据项目化。
   * research.db 落盘在「项目根 / data / research.db」，不存在全局库。
   * 项目根解析顺序：显式 dbPath > ROCK_PROJECT_ROOT 环境变量 > process.cwd()。
   * （单项目：项目根 = ROCK_PROJECT_ROOT，未设则当前工作目录）
   * 惰性创建 data/ 目录，首次调用即建库建表。
   */
  constructor(dbPath?: string) {
    const path = dbPath || ResearchRepository.resolveProjectDbPath();
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // 并发写（pi 与批量验证脚本）时短暂撞锁不立即抛 locked：等 10s 再判。
    // 与 extract_claims_batch.py 的 busy_timeout=30000 同理（pi 进程内写短，10s 足够）。
    this.db.pragma('busy_timeout = 10000');
    this.initSchema();
  }

  /** 项目级 research.db 路径：<projectRoot>/data/research.db */
  static resolveProjectDbPath(): string {
    const root = process.env.ROCK_PROJECT_ROOT || process.cwd();
    return join(root, 'data', 'research.db');
  }

  private initSchema(): void {
    // ESM 下 __dirname 不存在；用 import.meta.url 定位同目录 schema.sql
    const schemaPath = fileURLToPath(new URL('./schema.sql', import.meta.url));
    const schema = readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);
  }

  close(): void {
    this.db.close();
  }

  /**
   * 解析 project_id：
   * - 显式传值 → 直接用（允许 null 表示「不归属任何项目」）
   * - 未传（undefined）→ 若库里只有 1 个 active project，自动填它的 id；否则 null。
   * 这样 idea_save / hypothesis_save / claim_save 在用户没传 project_id 时不会存成 NULL，
   * 后续按 project 查询就能查到（之前 NULL 会「丢数据」）。
   */
  private resolveProjectId(explicit?: number): number | null {
    if (explicit != null) return explicit;
    const active = this.db.prepare(
      'SELECT id FROM projects WHERE status = ? ORDER BY updated_at DESC'
    ).all('active') as { id: number }[];
    if (active.length === 1) return active[0].id;
    // 退一步：整库只有 1 个 project 时也算唯一，填它
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n;
    if (total === 1) {
      const row = this.db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: number };
      return row?.id ?? null;
    }
    return null;
  }

  // ---- Projects ----

  createProject(name: string, description?: string): Project {
    const stmt = this.db.prepare(
      'INSERT INTO projects (name, description) VALUES (?, ?)'
    );
    const id = stmt.run(name, description || null).lastInsertRowid as number;
    return this.getProject(id)!;
  }

  getProject(id: number): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  }

  listProjects(status?: string): Project[] {
    if (status) {
      return this.db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY updated_at DESC').all(status) as Project[];
    }
    return this.db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as Project[];
  }

  // ---- Claims ----

  createClaim(opts: {
    project_id?: number;
    text: string;
    claim_type?: string;
    confidence?: number;
    supersedes_id?: number;
  }): Claim {
    const stmt = this.db.prepare(`
      INSERT INTO claims (project_id, text, claim_type, confidence, supersedes_id)
      VALUES (?, ?, ?, ?, ?)
    `);
    const id = stmt.run(
      this.resolveProjectId(opts.project_id),
      opts.text,
      opts.claim_type || null,
      opts.confidence ?? 0.5,
      opts.supersedes_id || null
    ).lastInsertRowid as number;
    return this.getClaim(id)!;
  }

  getClaim(id: number): Claim | undefined {
    return this.db.prepare('SELECT * FROM claims WHERE id = ?').get(id) as Claim | undefined;
  }

  searchClaims(query: string, projectId?: number): Claim[] {
    if (projectId) {
      return this.db.prepare(
        'SELECT * FROM claims WHERE project_id = ? AND text LIKE ? ORDER BY confidence DESC'
      ).all(projectId, `%${query}%`) as Claim[];
    }
    return this.db.prepare(
      'SELECT * FROM claims WHERE text LIKE ? ORDER BY confidence DESC'
    ).all(`%${query}%`) as Claim[];
  }

  updateClaimStatus(id: number, status: Claim['status']): void {
    this.db.prepare('UPDATE claims SET status = ? WHERE id = ?').run(status, id);
  }

  /** 查询所有 superseded_id 指向 claimId 的 claim（即后继声明，用于演化追踪）。 */
  getSupersedingClaims(claimId: number): Claim[] {
    return this.db.prepare(
      'SELECT * FROM claims WHERE supersedes_id = ? ORDER BY created_at ASC'
    ).all(claimId) as Claim[];
  }

  getClaimsByProject(projectId: number): Claim[] {
    return this.db.prepare(
      'SELECT * FROM claims WHERE project_id = ? ORDER BY created_at DESC'
    ).all(projectId) as Claim[];
  }

  // ---- Evidence ----

  addEvidence(opts: {
    claim_id: number;
    paper_id?: number;
    source_type?: string;
    file_path?: string;
    page?: number;
    section?: string;
    text_span?: string;
    evidence_type?: string;
    strength?: number;
  }): Evidence {
    const stmt = this.db.prepare(`
      INSERT INTO evidence (claim_id, paper_id, source_type, file_path, page, section, text_span, evidence_type, strength)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const id = stmt.run(
      opts.claim_id,
      opts.paper_id || null,
      opts.source_type || null,
      opts.file_path || null,
      opts.page || null,
      opts.section || null,
      opts.text_span || null,
      opts.evidence_type || 'supporting',
      opts.strength ?? 0.5
    ).lastInsertRowid as number;
    return this.db.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as Evidence;
  }

  getEvidenceForClaim(claimId: number): Evidence[] {
    return this.db.prepare(
      'SELECT * FROM evidence WHERE claim_id = ? ORDER BY strength DESC'
    ).all(claimId) as Evidence[];
  }

  // ---- Claim Verifications (接地验证历史，claim_verify 落库) ----

  saveVerification(opts: {
    claim_id?: number | null;
    claim_text: string;
    verdict: string;
    mode: string;
    cited_file?: string | null;
    cited_page?: number | null;
    judge_model?: string | null;
    matched: unknown[];
    notes?: string | null;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO claim_verifications
        (claim_id, claim_text, verdict, mode, cited_file, cited_page, judge_model, matched_json, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return Number(stmt.run(
      opts.claim_id ?? null,
      opts.claim_text,
      opts.verdict,
      opts.mode,
      opts.cited_file ?? null,
      opts.cited_page ?? null,
      opts.judge_model ?? null,
      JSON.stringify(opts.matched),
      opts.notes ?? null,
    ).lastInsertRowid);
  }

  getVerificationsForClaim(claimId: number): Array<{
    id: number; verdict: string; mode: string; cited_file: string | null;
    cited_page: number | null; judge_model: string | null; notes: string | null; created_at: string;
  }> {
    return this.db.prepare(
      `SELECT id, verdict, mode, cited_file, cited_page, judge_model, notes, created_at
       FROM claim_verifications WHERE claim_id = ? ORDER BY created_at DESC`
    ).all(claimId) as any[];
  }

  traceEvidence(paperId: number): Evidence[] {
    return this.db.prepare(
      'SELECT * FROM evidence WHERE paper_id = ? ORDER BY created_at DESC'
    ).all(paperId) as Evidence[];
  }

  // ---- Claim Relations ----

  addClaimRelation(sourceId: number, targetId: number, relation: string, rationale?: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO claim_relations (source_id, target_id, relation, rationale)
      VALUES (?, ?, ?, ?)
    `).run(sourceId, targetId, relation, rationale || null);
  }

  getClaimRelations(claimId: number): ClaimRelation[] {
    return this.db.prepare(
      `SELECT * FROM claim_relations WHERE source_id = ? OR target_id = ?`
    ).all(claimId, claimId) as ClaimRelation[];
  }

  getConflictingClaims(projectId?: number): ClaimRelation[] {
    if (projectId) {
      return this.db.prepare(`
        SELECT cr.* FROM claim_relations cr
        JOIN claims c ON c.id = cr.source_id
        WHERE cr.relation = 'contradicts' AND c.project_id = ?
      `).all(projectId) as ClaimRelation[];
    }
    return this.db.prepare(
      `SELECT * FROM claim_relations WHERE relation = 'contradicts'`
    ).all() as ClaimRelation[];
  }

  // ---- Ideas ----

  createIdea(opts: {
    project_id?: number;
    text: string;
    source_claims?: number[];
    rationale?: string;
    novelty?: number;
    plausibility?: number;
  }): Idea {
    const stmt = this.db.prepare(`
      INSERT INTO ideas (project_id, text, source_claims, rationale, novelty, plausibility)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const id = stmt.run(
      this.resolveProjectId(opts.project_id),
      opts.text,
      opts.source_claims ? JSON.stringify(opts.source_claims) : null,
      opts.rationale || null,
      opts.novelty ?? 0.5,
      opts.plausibility ?? 0.5
    ).lastInsertRowid as number;
    return this.db.prepare('SELECT * FROM ideas WHERE id = ?').get(id) as Idea;
  }

  searchIdeas(query: string, projectId?: number): Idea[] {
    if (projectId) {
      return this.db.prepare(
        'SELECT * FROM ideas WHERE project_id = ? AND text LIKE ? ORDER BY novelty DESC'
      ).all(projectId, `%${query}%`) as Idea[];
    }
    return this.db.prepare(
      'SELECT * FROM ideas WHERE text LIKE ? ORDER BY novelty DESC'
    ).all(`%${query}%`) as Idea[];
  }

  getIdeasByProject(projectId: number): Idea[] {
    return this.db.prepare(
      'SELECT * FROM ideas WHERE project_id = ? ORDER BY created_at DESC'
    ).all(projectId) as Idea[];
  }

  // ---- Hypotheses ----

  createHypothesis(opts: {
    idea_id?: number;
    project_id?: number;
    statement: string;
    prediction?: string;
    observable?: string;
    experiment?: string;
    falsification?: string;
  }): Hypothesis {
    const stmt = this.db.prepare(`
      INSERT INTO hypotheses (idea_id, project_id, statement, prediction, observable, experiment, falsification)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const id = stmt.run(
      opts.idea_id || null,
      this.resolveProjectId(opts.project_id),
      opts.statement,
      opts.prediction || null,
      opts.observable || null,
      opts.experiment || null,
      opts.falsification || null
    ).lastInsertRowid as number;
    return this.db.prepare('SELECT * FROM hypotheses WHERE id = ?').get(id) as Hypothesis;
  }

  getHypothesesByProject(projectId: number): Hypothesis[] {
    return this.db.prepare(
      'SELECT * FROM hypotheses WHERE project_id = ? ORDER BY created_at DESC'
    ).all(projectId) as Hypothesis[];
  }

  getHypothesesByIdea(ideaId: number): Hypothesis[] {
    return this.db.prepare(
      'SELECT * FROM hypotheses WHERE idea_id = ? ORDER BY created_at DESC'
    ).all(ideaId) as Hypothesis[];
  }

  updateHypothesisStatus(id: number, status: Hypothesis['status']): void {
    this.db.prepare(
      'UPDATE hypotheses SET status = ?, updated_at = datetime(\'now\') WHERE id = ?'
    ).run(status, id);
  }

  // ---- Research Log ----

  logSession(opts: {
    project_id?: number;
    query: string;
    mode: 'fast' | 'normal' | 'deep';
    summary?: string;
    claim_ids?: number[];
  }): void {
    this.db.prepare(`
      INSERT INTO research_sessions (project_id, query, mode, summary, claims_touched)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      opts.project_id || null,
      opts.query,
      opts.mode,
      opts.summary || null,
      opts.claim_ids ? JSON.stringify(opts.claim_ids) : null
    );
  }

  getRecentSessions(limit = 10): any[] {
    return this.db.prepare(
      'SELECT * FROM research_sessions ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
  }
}