-- New runs opt into assurance. Historical runs and delivery records are untouched.
CREATE TABLE task_assurance (
  run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  delivery_id TEXT,
  repository_root TEXT,
  observed_changes INTEGER NOT NULL DEFAULT 0 CHECK(observed_changes IN (0, 1)),
  retrieval_status TEXT NOT NULL DEFAULT 'pending',
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE task_memory_reviews (
  run_id TEXT NOT NULL REFERENCES task_assurance(run_id),
  delivery_id TEXT NOT NULL,
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  entry_revision INTEGER NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('adopted','inapplicable','contradicted')),
  basis TEXT NOT NULL,
  invariant_text TEXT NOT NULL,
  counterexample TEXT NOT NULL,
  verification TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL CHECK(json_valid(evidence_ids_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, delivery_id, entry_id, entry_revision)
) STRICT;
CREATE TABLE task_execution_evidence (
  evidence_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES task_assurance(run_id),
  delivery_id TEXT,
  repository_root TEXT NOT NULL,
  cwd TEXT NOT NULL,
  execution_digest TEXT NOT NULL,
  state_digest TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('passed','failed','skipped','unknown')),
  exit_code INTEGER,
  provenance TEXT NOT NULL CHECK(provenance IN ('model_reported','client_observed')),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX task_execution_evidence_run ON task_execution_evidence(run_id);
CREATE TABLE task_assurance_requests (
  run_id TEXT NOT NULL REFERENCES task_assurance(run_id),
  request_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK(json_valid(response_json)),
  PRIMARY KEY(run_id, request_id)
) STRICT;
CREATE TABLE codex_hook_requests (
  identity_digest TEXT PRIMARY KEY,
  repository_root TEXT NOT NULL,
  run_id TEXT REFERENCES ledger_runs(run_id),
  request_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','bound','cancelled')),
  stop_notified INTEGER NOT NULL DEFAULT 0,
  last_event TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE codex_hook_tools (
  identity_digest TEXT NOT NULL REFERENCES codex_hook_requests(identity_digest),
  call_id TEXT NOT NULL,
  run_id TEXT,
  delivery_id TEXT,
  input_digest TEXT NOT NULL,
  state_digest TEXT,
  evidence_id TEXT,
  post_state_digest TEXT,
  PRIMARY KEY(identity_digest, call_id)
) STRICT;
CREATE TABLE codex_hook_observations (
  observation_id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  tool_name TEXT,
  response_shape TEXT NOT NULL,
  decision TEXT NOT NULL,
  observed_at TEXT NOT NULL
) STRICT;
