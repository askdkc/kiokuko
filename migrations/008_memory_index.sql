CREATE TABLE memory_index_settings (workspace TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('off','observe','active'))) STRICT;
CREATE TABLE memory_index_pending (entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, revision INTEGER NOT NULL) STRICT;
CREATE TABLE memory_index_work (work_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES ledger_runs(run_id) ON DELETE CASCADE, delivery_id TEXT NOT NULL, workspace TEXT NOT NULL, stage TEXT NOT NULL, batch_json TEXT NOT NULL, batch_hash TEXT NOT NULL, template_version TEXT NOT NULL, expires_at TEXT NOT NULL) STRICT;
CREATE TABLE memory_index_operations (operation_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES memory_index_work(work_id) ON DELETE CASCADE, input_hash TEXT NOT NULL, response_json TEXT NOT NULL) STRICT;
CREATE TABLE memory_index_artifacts (entry_id TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE, work_id TEXT NOT NULL REFERENCES memory_index_work(work_id) ON DELETE CASCADE, knowledge_type TEXT NOT NULL CHECK(knowledge_type IN ('atomic','bridge')), output_hash TEXT NOT NULL, sources_json TEXT NOT NULL, entities_json TEXT NOT NULL, quotes_json TEXT NOT NULL, connection TEXT, state TEXT NOT NULL CHECK(state IN ('pending','supported','unsupported','uncertain','stale'))) STRICT;
CREATE TABLE memory_index_sources (artifact_id TEXT NOT NULL REFERENCES memory_index_artifacts(entry_id) ON DELETE CASCADE, source_id TEXT NOT NULL, source_revision INTEGER NOT NULL, PRIMARY KEY(artifact_id,source_id)) STRICT;
CREATE INDEX memory_index_artifacts_work ON memory_index_artifacts(work_id);
CREATE INDEX memory_index_work_workspace ON memory_index_work(workspace);
CREATE INDEX memory_index_sources_source ON memory_index_sources(source_id);
CREATE TRIGGER memory_index_new_revision AFTER INSERT ON entry_revisions WHEN typeof(NEW.revision)='integer' AND NEW.workspace <> 'global' AND NEW.kind <> 'preference' AND NEW.created_by <> 'kiokuko-memory-index' AND COALESCE(json_extract(NEW.provenance_json,'$.type'),'') NOT IN ('agent_derived_lesson','memory_index','external_skill','source_sync') BEGIN
 INSERT INTO memory_index_pending VALUES(NEW.entry_id,NEW.revision) ON CONFLICT(entry_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER memory_index_source_changed AFTER UPDATE OF current_revision,status ON entries BEGIN
 UPDATE memory_index_artifacts SET state='stale' WHERE entry_id IN (SELECT artifact_id FROM memory_index_sources WHERE source_id=NEW.id);
 DELETE FROM memory_index_pending WHERE entry_id=NEW.id;
 INSERT INTO memory_index_pending SELECT NEW.id,NEW.current_revision WHERE typeof(NEW.current_revision)='integer' AND NEW.workspace <> 'global' AND NEW.status <> 'superseded' AND NEW.created_by <> 'kiokuko-memory-index' AND EXISTS(SELECT 1 FROM entry_revisions r WHERE r.entry_id=NEW.id AND r.revision=NEW.current_revision AND r.kind <> 'preference' AND COALESCE(json_extract(r.provenance_json,'$.type'),'') NOT IN ('agent_derived_lesson','memory_index','external_skill','source_sync')) ON CONFLICT(entry_id) DO UPDATE SET revision=excluded.revision;
END;
CREATE TRIGGER memory_index_source_purged BEFORE DELETE ON entries BEGIN
 DELETE FROM memory_index_operations WHERE work_id IN (SELECT a.work_id FROM memory_index_artifacts a JOIN memory_index_sources s ON s.artifact_id=a.entry_id WHERE s.source_id=OLD.id);
 DELETE FROM entries WHERE id IN (SELECT artifact_id FROM memory_index_sources WHERE source_id=OLD.id) OR id IN (SELECT entry_id FROM memory_index_artifacts WHERE work_id IN (SELECT work_id FROM memory_index_work WHERE EXISTS(SELECT 1 FROM json_each(batch_json) WHERE json_extract(value,'$.entryId')=OLD.id)));
 DELETE FROM memory_index_work WHERE EXISTS(SELECT 1 FROM json_each(batch_json) WHERE json_extract(value,'$.entryId')=OLD.id);
END;

-- Purge all stored copies and foreign-key references before deleting a managed
-- output or a source bound to maintenance work. Ordinary purge is unchanged.
CREATE TRIGGER memory_index_purge_references BEFORE DELETE ON entries
WHEN OLD.created_by='kiokuko-memory-index' OR EXISTS(SELECT 1 FROM memory_index_work WHERE EXISTS(SELECT 1 FROM json_each(batch_json) WHERE json_extract(value,'$.entryId')=OLD.id)) BEGIN
 DELETE FROM task_assurance_requests WHERE run_id IN (SELECT run_id FROM memory_index_work WHERE EXISTS(SELECT 1 FROM json_each(batch_json) WHERE json_extract(value,'$.entryId')=OLD.id));
 DELETE FROM task_assurance_requests WHERE run_id IN (SELECT cd.run_id FROM context_deliveries cd JOIN context_delivery_entries de ON de.delivery_id=cd.delivery_id WHERE de.entry_id=OLD.id);
 DELETE FROM context_delivery_entries WHERE entry_id=OLD.id;
 DELETE FROM context_feedback WHERE entry_id=OLD.id;
 DELETE FROM ledger_memory_links WHERE entry_id=OLD.id;
 DELETE FROM entry_links WHERE from_entry_id=OLD.id OR to_entry_id=OLD.id;
 DELETE FROM audit_events WHERE entry_id=OLD.id;
END;

CREATE TRIGGER memory_index_contradiction AFTER INSERT ON entry_links WHEN NEW.relation='contradicts' BEGIN
 UPDATE memory_index_artifacts SET state='stale' WHERE knowledge_type='bridge' AND entry_id IN (SELECT artifact_id FROM memory_index_sources WHERE source_id=NEW.from_entry_id) AND entry_id IN (SELECT artifact_id FROM memory_index_sources WHERE source_id=NEW.to_entry_id);
END;
