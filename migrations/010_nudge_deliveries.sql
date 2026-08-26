CREATE TABLE nudge_deliveries (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 100),
    code TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 100),
    occurrence_id TEXT NOT NULL CHECK (length(occurrence_id) BETWEEN 1 AND 256),
    through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0),
    priority INTEGER NOT NULL CHECK (priority >= 1),
    delivered_at TEXT NOT NULL,

    FOREIGN KEY (run_id)
        REFERENCES ledger_runs(run_id)
        ON DELETE CASCADE,

    UNIQUE (
        run_id,
        policy_version,
        occurrence_id
    )
);

CREATE INDEX nudge_deliveries_run_code_sequence
ON nudge_deliveries (
    run_id,
    policy_version,
    code,
    through_sequence
);

CREATE INDEX nudge_deliveries_run_sequence
ON nudge_deliveries (
    run_id,
    through_sequence
);
