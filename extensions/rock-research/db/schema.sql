-- Rock Research Database Schema
-- Phase 1: Claims / Evidence / Projects
-- Phase 2: Relations / Conflicts / Supersession
-- Phase 3: Ideas / Hypotheses

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- Projects: research context container
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT,
    status      TEXT DEFAULT 'active' CHECK(status IN ('active', 'archived', 'completed')),
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- Claims: research statements with provenance
-- ============================================================
CREATE TABLE IF NOT EXISTS claims (
    id            INTEGER PRIMARY KEY,
    project_id    INTEGER REFERENCES projects(id),
    text          TEXT NOT NULL,
    claim_type    TEXT CHECK(claim_type IN ('observation', 'interpretation', 'generalization', 'mechanism', 'method', 'result', 'limitation')),
    status        TEXT DEFAULT 'active' CHECK(status IN ('active', 'superseded', 'retracted', 'disputed')),
    confidence    REAL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),
    evidence_strength REAL DEFAULT 0.0,
    contradiction_level REAL DEFAULT 0.0,
    novelty       REAL DEFAULT 0.0,
    testability   REAL DEFAULT 0.0,
    source_tier   INTEGER DEFAULT 0,       -- 0=unknown, 1=local_pdf, 2=local_meta, 3=trusted_ext, 4=external_snippet
    valid_from    TEXT DEFAULT (datetime('now')),
    valid_to      TEXT,
    supersedes_id INTEGER REFERENCES claims(id),
    superseded_by INTEGER REFERENCES claims(id),
    created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_claims_project ON claims(project_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
CREATE INDEX IF NOT EXISTS idx_claims_supersedes ON claims(supersedes_id);

-- ============================================================
-- Evidence: specific provenance for a claim
-- ============================================================
CREATE TABLE IF NOT EXISTS evidence (
    id            INTEGER PRIMARY KEY,
    claim_id      INTEGER NOT NULL REFERENCES claims(id),
    paper_id      INTEGER,                         -- 保留字段（无全局论文表，当前不填充）
    source_type   TEXT CHECK(source_type IN ('paper', 'experiment', 'user_data', 'external', 'synthesis')),
    file_path     TEXT,                             -- local PDF path
    page          INTEGER,
    section       TEXT,
    text_span     TEXT,                             -- exact quoted text
    evidence_type TEXT CHECK(evidence_type IN ('direct', 'supporting', 'contradicting', 'indirect', 'contextual')),
    strength      REAL DEFAULT 0.5 CHECK(strength >= 0 AND strength <= 1),
    created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_evidence_claim ON evidence(claim_id);
CREATE INDEX IF NOT EXISTS idx_evidence_paper ON evidence(paper_id);

-- ============================================================
-- Claim Relations: how claims relate to each other
-- ============================================================
CREATE TABLE IF NOT EXISTS claim_relations (
    source_id     INTEGER NOT NULL REFERENCES claims(id),
    target_id     INTEGER NOT NULL REFERENCES claims(id),
    relation      TEXT NOT NULL CHECK(relation IN ('supports', 'contradicts', 'qualifies', 'refines', 'supersedes', 'derived_from', 'generalizes', 'specializes')),
    rationale     TEXT,                             -- why this relation was established
    created_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(source_id, target_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_claim_relations_source ON claim_relations(source_id);
CREATE INDEX IF NOT EXISTS idx_claim_relations_target ON claim_relations(target_id);

-- ============================================================
-- Ideas: speculative research ideas (pre-hypothesis)
-- ============================================================
CREATE TABLE IF NOT EXISTS ideas (
    id            INTEGER PRIMARY KEY,
    project_id    INTEGER REFERENCES projects(id),
    text          TEXT NOT NULL,
    source_claims TEXT,                             -- JSON array of claim IDs that inspired this
    rationale     TEXT,
    novelty       REAL DEFAULT 0.5,
    plausibility  REAL DEFAULT 0.5,
    status        TEXT DEFAULT 'active' CHECK(status IN ('active', 'explored', 'abandoned', 'promoted_to_hypothesis')),
    created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ideas_project ON ideas(project_id);

-- ============================================================
-- Idea Relations: connections between ideas
-- ============================================================
CREATE TABLE IF NOT EXISTS idea_relations (
    source_id     INTEGER NOT NULL REFERENCES ideas(id),
    target_id     INTEGER NOT NULL REFERENCES ideas(id),
    relation      TEXT NOT NULL CHECK(relation IN ('extends', 'contradicts', 'alternative_to', 'precedes', 'derived_from', 'generalizes')),
    rationale     TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    UNIQUE(source_id, target_id, relation)
);

-- ============================================================
-- Hypotheses: testable hypotheses derived from ideas
-- ============================================================
CREATE TABLE IF NOT EXISTS hypotheses (
    id            INTEGER PRIMARY KEY,
    idea_id       INTEGER REFERENCES ideas(id),
    project_id    INTEGER REFERENCES projects(id),
    statement     TEXT NOT NULL,
    prediction    TEXT,                             -- what should be observed
    observable    TEXT,                             -- how to measure
    experiment    TEXT,                             -- proposed experiment
    falsification TEXT,                             -- what would disprove this
    status        TEXT DEFAULT 'proposed' CHECK(status IN ('proposed', 'in_design', 'testing', 'supported', 'falsified', 'abandoned')),
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hypotheses_project ON hypotheses(project_id);
CREATE INDEX IF NOT EXISTS idx_hypotheses_idea ON hypotheses(idea_id);

-- ============================================================
-- Experiments: experimental campaigns
-- ============================================================
CREATE TABLE IF NOT EXISTS experiments (
    id            INTEGER PRIMARY KEY,
    project_id    INTEGER REFERENCES projects(id),
    hypothesis_id INTEGER REFERENCES hypotheses(id),
    name          TEXT NOT NULL,
    description   TEXT,
    status        TEXT DEFAULT 'planned' CHECK(status IN ('planned', 'running', 'completed', 'aborted')),
    results_summary TEXT,
    data_path     TEXT,                             -- path to raw data files
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- Research Sessions: log of analysis sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS research_sessions (
    id            INTEGER PRIMARY KEY,
    project_id    INTEGER REFERENCES projects(id),
    query         TEXT,
    mode          TEXT CHECK(mode IN ('fast', 'normal', 'deep')),
    summary       TEXT,
    claims_touched TEXT,                            -- JSON array of claim IDs
    created_at    TEXT DEFAULT (datetime('now'))
);

-- ============================================================
-- Claim Verifications: claim_verify 的接地验证历史（可审计闭环）
-- 每次 verifyAgainstSource 落一条，供 evidence_trace 回溯验证链。
-- ============================================================
CREATE TABLE IF NOT EXISTS claim_verifications (
    id            INTEGER PRIMARY KEY,
    claim_id      INTEGER REFERENCES claims(id),    -- 无靶模式可空
    claim_text    TEXT NOT NULL,
    verdict       TEXT NOT NULL,                    -- CORRECT|MISATTRIBUTED|BROKEN_CITATION|...
    mode          TEXT CHECK(mode IN ('TARGETED_SPAN','TARGETED_FILE','UNGUIDED')),
    cited_file    TEXT,
    cited_page    INTEGER,
    judge_model   TEXT,                             -- LLM 判官模型名；仅结构接地时为 NULL
    matched_json  TEXT,                             -- JSON: matched_passages 快照
    notes         TEXT,
    created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_verifications_claim ON claim_verifications(claim_id);