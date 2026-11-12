CREATE TABLE memory_capture_receipts (
  receipt_id TEXT PRIMARY KEY,
  repository_root TEXT NOT NULL,
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  body_digest TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX memory_capture_receipts_turn ON memory_capture_receipts(repository_root, source, session_id, turn_id);
ALTER TABLE memory_capture_candidates ADD COLUMN review_token TEXT;
ALTER TABLE memory_capture_candidates ADD COLUMN review_until TEXT;
ALTER TABLE memory_capture_candidates ADD COLUMN review_reason TEXT;
CREATE TABLE memory_capture_presentations (
  candidate_id TEXT NOT NULL REFERENCES memory_capture_candidates(candidate_id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  presented_at TEXT NOT NULL,
  PRIMARY KEY(candidate_id, request_id)
);
