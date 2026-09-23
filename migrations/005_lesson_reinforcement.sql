-- Observations are local execution history, not a declaration of factual trust.
-- No historical entries or runs are backfilled.
CREATE TABLE lesson_observations (
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
  run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL,
  entry_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(fingerprint, run_id),
  FOREIGN KEY(entry_id, entry_revision) REFERENCES entry_revisions(entry_id, revision) ON DELETE CASCADE
) STRICT;
CREATE INDEX lesson_observations_entry ON lesson_observations(entry_id, entry_revision);

CREATE TRIGGER lesson_observations_invalidate
AFTER UPDATE OF current_revision, status ON entries
WHEN NEW.current_revision <> OLD.current_revision OR NEW.status = 'superseded'
BEGIN
  DELETE FROM lesson_observations WHERE entry_id = NEW.id;
END;
