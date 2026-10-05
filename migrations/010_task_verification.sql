-- Existing runs remain explicitly legacy; only newly enrolled runs opt in.
ALTER TABLE task_assurance ADD COLUMN verification_version INTEGER NOT NULL DEFAULT 0 CHECK(verification_version IN (0, 1));
-- Preserve positional inserts made by an already-running older MCP process.
CREATE TABLE task_execution_targets (
  evidence_id TEXT PRIMARY KEY REFERENCES task_execution_evidence(evidence_id),
  target TEXT NOT NULL
) STRICT;
CREATE TABLE task_verification_contracts (
  run_id TEXT NOT NULL REFERENCES task_assurance(run_id),
  version INTEGER NOT NULL CHECK(version > 0),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(run_id, version)
) STRICT;
CREATE TABLE task_verification_checks (
  run_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  check_id TEXT NOT NULL,
  target TEXT NOT NULL,
  expected TEXT NOT NULL,
  method TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  PRIMARY KEY(run_id, contract_version, check_id),
  FOREIGN KEY(run_id, contract_version) REFERENCES task_verification_contracts(run_id, version)
) STRICT;
CREATE TABLE task_verification_results (
  sequence INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  check_id TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  target TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('passed', 'failed', 'skipped', 'unknown')),
  state_digest TEXT NOT NULL,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  provenance TEXT NOT NULL CHECK(provenance IN ('model_reported', 'client_observed')),
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id, contract_version, check_id) REFERENCES task_verification_checks(run_id, contract_version, check_id)
) STRICT;
CREATE INDEX task_verification_latest ON task_verification_results(run_id, check_id, sequence DESC);
