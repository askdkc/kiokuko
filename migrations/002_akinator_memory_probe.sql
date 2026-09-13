-- Rebuildable profile search projection; canonical sessions and ledger remain authoritative.
CREATE TABLE akinator_profile_documents (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL UNIQUE REFERENCES akinator_sessions(id) ON DELETE CASCADE,
    workspace TEXT NOT NULL,
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
    task_text TEXT NOT NULL,
    target TEXT NOT NULL,
    profile_hash TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    projection_version INTEGER NOT NULL CHECK (projection_version = 1)
);
CREATE INDEX idx_akinator_profile_scope ON akinator_profile_documents(workspace, repository_id, run_id);
CREATE TABLE akinator_profile_signals (
    document_id INTEGER NOT NULL REFERENCES akinator_profile_documents(id) ON DELETE CASCADE,
    workspace TEXT NOT NULL,
    repository_id TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (document_id, value)
);
CREATE INDEX idx_akinator_profile_signal ON akinator_profile_signals(workspace, repository_id, value, document_id);
CREATE VIRTUAL TABLE akinator_profile_fts USING fts5(task_text, target, content='akinator_profile_documents', content_rowid='id');
CREATE VIRTUAL TABLE akinator_profile_trigram USING fts5(task_text, target, content='akinator_profile_documents', content_rowid='id', tokenize='trigram');
CREATE TRIGGER akinator_profile_insert AFTER INSERT ON akinator_profile_documents BEGIN
    INSERT INTO akinator_profile_fts(rowid, task_text, target) VALUES (new.id, new.task_text, new.target);
    INSERT INTO akinator_profile_trigram(rowid, task_text, target) VALUES (new.id, new.task_text, new.target);
END;
CREATE TRIGGER akinator_profile_delete AFTER DELETE ON akinator_profile_documents BEGIN
    INSERT INTO akinator_profile_fts(akinator_profile_fts, rowid, task_text, target) VALUES ('delete', old.id, old.task_text, old.target);
    INSERT INTO akinator_profile_trigram(akinator_profile_trigram, rowid, task_text, target) VALUES ('delete', old.id, old.task_text, old.target);
END;
CREATE TRIGGER akinator_profile_update AFTER UPDATE ON akinator_profile_documents BEGIN
    INSERT INTO akinator_profile_fts(akinator_profile_fts, rowid, task_text, target) VALUES ('delete', old.id, old.task_text, old.target);
    INSERT INTO akinator_profile_trigram(akinator_profile_trigram, rowid, task_text, target) VALUES ('delete', old.id, old.task_text, old.target);
    INSERT INTO akinator_profile_fts(rowid, task_text, target) VALUES (new.id, new.task_text, new.target);
    INSERT INTO akinator_profile_trigram(rowid, task_text, target) VALUES (new.id, new.task_text, new.target);
END;
CREATE TABLE akinator_profile_projection_state (
    workspace TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(repository_id),
    projection_version INTEGER NOT NULL CHECK (projection_version = 1),
    cursor TEXT NOT NULL DEFAULT '',
    complete INTEGER NOT NULL CHECK (complete IN (0, 1))
);
CREATE TABLE akinator_memory_resolutions (
    run_id TEXT PRIMARY KEY REFERENCES ledger_runs(run_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL UNIQUE REFERENCES akinator_sessions(id) ON DELETE CASCADE,
    workspace TEXT NOT NULL,
    resolution_json TEXT NOT NULL CHECK (json_valid(resolution_json)),
    created_at TEXT NOT NULL
);
-- References contain no copied candidate values. Purge removes even the references.
CREATE TRIGGER akinator_memory_source_purge BEFORE DELETE ON ledger_runs BEGIN
    UPDATE akinator_memory_resolutions
       SET resolution_json = json_set(resolution_json, '$.candidates', json('[]'), '$.adoptedRunId', NULL, '$.status', 'revoked')
     WHERE EXISTS (SELECT 1 FROM json_each(resolution_json, '$.candidates') AS candidate
                   WHERE json_extract(candidate.value, '$.runId') = old.run_id);
END;

CREATE TRIGGER akinator_memory_resolution_binding BEFORE INSERT ON akinator_memory_resolutions BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM run_intakes i JOIN ledger_runs r ON r.run_id = i.run_id
      JOIN akinator_sessions s ON s.id = i.session_id
      WHERE i.run_id = new.run_id AND i.session_id = new.session_id
        AND r.workspace = new.workspace AND s.workspace = new.workspace
    ) THEN RAISE(ABORT, 'profile resolution binding mismatch') END;
END;
