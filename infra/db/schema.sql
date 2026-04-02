-- Memory OS v0 Database Schema

-- Sessions: top-level chat/work session containers
CREATE TABLE IF NOT EXISTS sessions (
  session_id    TEXT PRIMARY KEY,
  project_id    TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at      TIMESTAMPTZ,
  source        TEXT NOT NULL DEFAULT 'manual',
  metadata      JSONB NOT NULL DEFAULT '{}'
);

-- Raw events: immutable log of all events within a session
CREATE TABLE IF NOT EXISTS raw_events (
  event_id      TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(session_id),
  event_type    TEXT NOT NULL,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL,
  sequence_num  INTEGER NOT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX idx_raw_events_session ON raw_events(session_id);
CREATE INDEX idx_raw_events_occurred ON raw_events(occurred_at);

-- Memory proposals: AI-proposed writes, pending human review
CREATE TABLE IF NOT EXISTS memory_proposals (
  proposal_id       TEXT PRIMARY KEY,
  session_id        TEXT REFERENCES sessions(session_id),
  memory_type       TEXT NOT NULL,
  operation         TEXT NOT NULL CHECK (operation IN ('create','update','supersede','invalidate')),
  target_memory_id  TEXT,
  proposed_content  TEXT NOT NULL,
  reason            TEXT NOT NULL,
  source_refs       JSONB NOT NULL DEFAULT '[]',
  confidence        NUMERIC(4,3) CHECK (confidence >= 0 AND confidence <= 1),
  risk_level        TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high')),
  approval_required BOOLEAN NOT NULL DEFAULT true,
  proposer          TEXT NOT NULL DEFAULT 'system',
  conflict_candidates JSONB NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','committed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_proposals_status ON memory_proposals(status);
CREATE INDEX idx_proposals_session ON memory_proposals(session_id);

-- Memory commits: audit log of proposal decisions
CREATE TABLE IF NOT EXISTS memory_commits (
  commit_id     TEXT PRIMARY KEY,
  proposal_id   TEXT NOT NULL REFERENCES memory_proposals(proposal_id),
  decision      TEXT NOT NULL CHECK (decision IN ('accepted','rejected','merged')),
  decided_by    TEXT NOT NULL CHECK (decided_by IN ('system','human','rule_engine')),
  decision_note TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_commits_proposal ON memory_commits(proposal_id);

-- Memories: canonical memory store
CREATE TABLE IF NOT EXISTS memories (
  memory_id       TEXT PRIMARY KEY,
  memory_type     TEXT NOT NULL,
  content         TEXT NOT NULL,
  summary         TEXT,
  trust_level     TEXT NOT NULL DEFAULT 't1_extracted',
  importance_score NUMERIC(4,3) CHECK (importance_score >= 0 AND importance_score <= 1),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','invalidated')),
  valid_from      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to        TIMESTAMPTZ,
  project_id      TEXT,
  source_refs     JSONB NOT NULL DEFAULT '[]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ
);

CREATE INDEX idx_memories_type ON memories(memory_type);
CREATE INDEX idx_memories_status ON memories(status);
CREATE INDEX idx_memories_project ON memories(project_id);
CREATE INDEX idx_memories_trust ON memories(trust_level);

-- Memory lineage: tracks parent/child relationships between memories
CREATE TABLE IF NOT EXISTS memory_lineage (
  id              SERIAL PRIMARY KEY,
  memory_id       TEXT NOT NULL REFERENCES memories(memory_id),
  parent_memory_id TEXT REFERENCES memories(memory_id),
  derived_from    TEXT REFERENCES memories(memory_id),
  commit_id       TEXT REFERENCES memory_commits(commit_id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_lineage_memory ON memory_lineage(memory_id);
CREATE INDEX idx_lineage_parent ON memory_lineage(parent_memory_id);

-- Artifact references: pointers to external artifacts
CREATE TABLE IF NOT EXISTS artifact_references (
  artifact_id   TEXT PRIMARY KEY,
  memory_id     TEXT NOT NULL REFERENCES memories(memory_id),
  artifact_type TEXT NOT NULL,
  uri           TEXT NOT NULL,
  label         TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_artifacts_memory ON artifact_references(memory_id);
