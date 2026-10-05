ALTER TABLE task_assurance ADD COLUMN observation_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_assurance ADD COLUMN observed_state_digest TEXT;
CREATE TABLE task_memory_decisions (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 decision_id TEXT NOT NULL UNIQUE,
 run_id TEXT NOT NULL REFERENCES task_assurance(run_id) ON DELETE CASCADE,
 entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
 entry_revision INTEGER NOT NULL,
 context_hash TEXT NOT NULL,
 source_delivery_id TEXT NOT NULL,
 review_json TEXT NOT NULL CHECK(json_valid(review_json))
) STRICT;
CREATE INDEX task_memory_decisions_lookup ON task_memory_decisions(run_id,entry_id,entry_revision,sequence DESC);
CREATE TABLE task_delivery_decisions (
 run_id TEXT NOT NULL REFERENCES task_assurance(run_id) ON DELETE CASCADE,
 delivery_id TEXT NOT NULL REFERENCES context_deliveries(delivery_id) ON DELETE CASCADE,
 entry_id TEXT NOT NULL,
 entry_revision INTEGER NOT NULL,
 decision_id TEXT NOT NULL REFERENCES task_memory_decisions(decision_id) ON DELETE CASCADE,
 PRIMARY KEY(run_id,delivery_id,entry_id,entry_revision)
) STRICT;
CREATE TABLE task_delivery_signals (delivery_id TEXT PRIMARY KEY REFERENCES context_deliveries(delivery_id) ON DELETE CASCADE, errors_json TEXT NOT NULL CHECK(json_valid(errors_json))) STRICT;
