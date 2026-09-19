-- A rebuildable projection, not a replacement for immutable revision hashes.
CREATE TABLE interaction_memory_fingerprints (
    entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
    workspace TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
    FOREIGN KEY (entry_id, revision) REFERENCES entry_revisions(entry_id, revision) ON DELETE CASCADE
);
CREATE INDEX idx_interaction_memory_fingerprint
    ON interaction_memory_fingerprints(workspace, fingerprint, entry_id);

CREATE TRIGGER interaction_memory_invalidate
AFTER UPDATE OF current_revision, status ON entries
WHEN NEW.current_revision <> OLD.current_revision OR NEW.status = 'superseded'
BEGIN
    DELETE FROM interaction_memory_fingerprints WHERE entry_id = NEW.id;
END;
