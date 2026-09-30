-- Connected agents may submit untrusted lesson candidates with revision-bound sources.
CREATE TABLE lesson_derivation_operations (
  operation_id TEXT PRIMARY KEY,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
  delivery_id TEXT REFERENCES context_deliveries(delivery_id) ON DELETE SET NULL,
  workspace TEXT NOT NULL,
  output_entry_id TEXT NOT NULL,
  output_revision INTEGER NOT NULL CHECK (output_revision > 0),
  output_content_hash TEXT NOT NULL CHECK (length(output_content_hash) = 64 AND output_content_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  FOREIGN KEY (output_entry_id, output_revision)
    REFERENCES entry_revisions(entry_id, revision) ON DELETE CASCADE
) STRICT;

CREATE TABLE lesson_derivation_sources (
  operation_id TEXT NOT NULL REFERENCES lesson_derivation_operations(operation_id) ON DELETE CASCADE,
  output_entry_id TEXT NOT NULL,
  output_revision INTEGER NOT NULL CHECK (output_revision > 0),
  source_workspace TEXT NOT NULL,
  source_entry_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL CHECK (source_revision > 0),
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64 AND source_content_hash NOT GLOB '*[^0-9a-f]*'),
  source_role TEXT NOT NULL CHECK (source_role IN ('experience', 'counterexample', 'correction', 'evidence')),
  PRIMARY KEY (operation_id, source_entry_id, source_revision),
  FOREIGN KEY (output_entry_id, output_revision)
    REFERENCES entry_revisions(entry_id, revision) ON DELETE CASCADE
) STRICT;

CREATE INDEX lesson_derivation_sources_output
  ON lesson_derivation_sources(output_entry_id, output_revision);
CREATE INDEX lesson_derivation_sources_source
  ON lesson_derivation_sources(source_workspace, source_entry_id, source_revision);
