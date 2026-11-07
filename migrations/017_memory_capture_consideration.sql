CREATE TABLE memory_capture_reservations (
  event_id TEXT PRIMARY KEY,
  repository_root TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  agent_id TEXT,
  transcript_path TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','processing','useful_candidates','no_candidates','evidence_insufficient','processing_failed','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX memory_capture_reservations_root ON memory_capture_reservations(repository_root, state);
CREATE TABLE memory_capture_candidates (
  candidate_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES memory_capture_reservations(event_id),
  workspace TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  evidence_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  digest TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending_review','declined','saved')),
  presented_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX memory_capture_candidate_evidence ON memory_capture_candidates(workspace, evidence_key);
