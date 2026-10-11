-- Additive and opt-in. Existing installations keep all detail until configured.
ALTER TABLE codex_hook_tools ADD COLUMN completion_state TEXT NOT NULL DEFAULT 'admitted' CHECK(completion_state IN ('admitted','running','unknown','completed','changed'));
CREATE TABLE task_execution_observations (
 run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id),
 unknown_exit_calls INTEGER NOT NULL DEFAULT 0,
 running_calls INTEGER NOT NULL DEFAULT 0,
 structured_exit_calls INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE diagnostic_retention_settings (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 retention_days INTEGER CHECK(retention_days BETWEEN 1 AND 36500),
 last_maintenance_at TEXT
) STRICT;
INSERT INTO diagnostic_retention_settings(singleton) VALUES(1);
CREATE TABLE diagnostic_run_summaries (
 run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id),
 expired_at TEXT NOT NULL,
 summary_json TEXT NOT NULL CHECK(json_valid(summary_json))
) STRICT;
CREATE TABLE codex_hook_receipts (
 identity_digest TEXT NOT NULL REFERENCES codex_hook_requests(identity_digest),
 call_id TEXT NOT NULL,
 input_digest TEXT NOT NULL,
 completion_state TEXT NOT NULL,
 PRIMARY KEY(identity_digest,call_id)
) STRICT;
CREATE TABLE codex_hook_processes (
 identity_digest TEXT NOT NULL,
 session_id TEXT NOT NULL,
 call_id TEXT NOT NULL,
 PRIMARY KEY(identity_digest,session_id),
 FOREIGN KEY(identity_digest,call_id) REFERENCES codex_hook_tools(identity_digest,call_id) ON DELETE CASCADE
) STRICT;
ALTER TABLE task_execution_observations ADD COLUMN last_exit_metadata TEXT NOT NULL DEFAULT 'unobserved' CHECK(last_exit_metadata IN ('available','unavailable','unobserved'));
-- Preserve historical observations without creating new unknown evidence rows.
INSERT INTO task_execution_observations(run_id,unknown_exit_calls,structured_exit_calls,last_exit_metadata)
 SELECT run_id,SUM(outcome='unknown'),SUM(outcome IN ('passed','failed')),
   CASE (SELECT outcome FROM task_execution_evidence last WHERE last.run_id=e.run_id AND last.provenance='client_observed' ORDER BY last.created_at DESC,last.rowid DESC LIMIT 1)
     WHEN 'unknown' THEN 'unavailable' ELSE 'available' END
 FROM task_execution_evidence e WHERE provenance='client_observed' GROUP BY run_id;
UPDATE codex_hook_tools SET completion_state='unknown'
 WHERE evidence_id IN (SELECT evidence_id FROM task_execution_evidence WHERE outcome='unknown');

CREATE INDEX context_feedback_entry_revision_lookup ON context_feedback(entry_id,delivery_id,run_id,verdict);
