-- Raw code evidence is operational history, never an approved memory or execution permission.
CREATE TABLE code_version_evidence (
 version_id TEXT PRIMARY KEY,
 evidence_id TEXT NOT NULL UNIQUE REFERENCES ledger_evidence(evidence_id) ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
 entry_id TEXT REFERENCES entries(id) ON DELETE CASCADE,
 workspace TEXT NOT NULL,
 repository_id TEXT NOT NULL REFERENCES repositories(repository_id) ON DELETE CASCADE,
 owner_id TEXT NOT NULL,
 branch TEXT,
 parent_version_id TEXT,
 path TEXT NOT NULL,
 reported_outcome TEXT NOT NULL CHECK(reported_outcome IN ('accepted','rejected','failed','unknown')),
 reason TEXT NOT NULL,
 environment_json TEXT NOT NULL CHECK(json_valid(environment_json)),
 required_environment_json TEXT CHECK(required_environment_json IS NULL OR json_valid(required_environment_json)),
 diff_text TEXT NOT NULL,
 diff_digest TEXT NOT NULL CHECK(length(diff_digest)=64),
 binding_digest TEXT NOT NULL CHECK(length(binding_digest)=64),
 created_at TEXT NOT NULL
) STRICT;
CREATE INDEX code_version_recall ON code_version_evidence(owner_id,repository_id,workspace,branch,entry_id,created_at DESC,version_id ASC);
CREATE TRIGGER code_version_immutable BEFORE UPDATE ON code_version_evidence
BEGIN SELECT RAISE(ABORT,'Code version evidence is immutable'); END;

CREATE INDEX entry_supersession_history ON entries(workspace,superseded_by,id) WHERE status='superseded';
