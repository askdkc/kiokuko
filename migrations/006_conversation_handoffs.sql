-- Ephemeral, model-reported continuity. Never indexed as durable knowledge.
CREATE TABLE conversation_handoffs (
  handoff_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision > 0),
  client_kind TEXT NOT NULL,
  location TEXT NOT NULL,
  run_id TEXT REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
  state_json TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
CREATE INDEX conversation_handoffs_expiry ON conversation_handoffs(expires_at);
