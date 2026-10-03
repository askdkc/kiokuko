CREATE TABLE task_preparation_recoveries (
 predecessor_run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id),
 successor_run_id TEXT NOT NULL UNIQUE REFERENCES ledger_runs(run_id),
 request_digest TEXT NOT NULL,
 operation_hash TEXT NOT NULL UNIQUE,
 logical_request_hash TEXT NOT NULL,
 old_catalog_digest TEXT NOT NULL,
 new_catalog_digest TEXT NOT NULL,
 created_at TEXT NOT NULL,
 CHECK (predecessor_run_id <> successor_run_id)
) STRICT;
