CREATE TABLE memory_observation_heads (
  workspace TEXT NOT NULL REFERENCES repositories(workspace), producer TEXT NOT NULL,
  source_id TEXT NOT NULL, source_revision INTEGER NOT NULL, content_hash TEXT NOT NULL,
  ledger_event_id TEXT NOT NULL REFERENCES ledger_events(event_id), entry_id TEXT NOT NULL REFERENCES entries(id),
  session_id TEXT NOT NULL, kind TEXT NOT NULL, tombstone INTEGER NOT NULL CHECK(tombstone IN (0,1)),
  payload_json TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(workspace,producer,source_id)
);
CREATE INDEX memory_observation_session ON memory_observation_heads(workspace,session_id,updated_at);
CREATE TABLE memory_principle_references (
  principle_key TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id), evidence_hash TEXT NOT NULL
);
