import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash, canonicalJson } from '../serialization/validate.js';
import { readAkinatorSession, readRunIntakeLink } from './store.js';
import { parseMemoryResolution, type MemoryResolution, type ProfileCandidate, type ProfileEvidence, type ProfileMemoryScope } from './memory-probe-types.js';
import { profileSignals } from './profile-memory-resolver.js';

export function assertProfileMemoryScope(database: SqliteDatabase, scope: ProfileMemoryScope): void {
  const row = database.prepare(`SELECT 1 AS present FROM repositories r JOIN repository_locations l
    ON l.repository_id = r.repository_id WHERE r.repository_id = ? AND r.workspace = ? AND l.canonical_root = ?`)
    .get(scope.repositoryId, scope.workspace, scope.repositoryRoot);
  if (!row) throw new KiokukoError('CONFLICT', 'Profile memory repository binding changed');
}

/** Canonical reads; a missing/purged source is withheld, corruption is not swallowed. */
export function readProfileCandidate(database: SqliteDatabase, workspace: string, evidence: ProfileEvidence): ProfileCandidate | null {
  const run = database.prepare(`SELECT r.status, i.session_id, p.repository_id FROM ledger_runs r
    JOIN run_intakes i ON i.run_id = r.run_id JOIN repositories p ON p.workspace = r.workspace
    WHERE r.run_id = ? AND r.workspace = ?`).get<{ status: string; session_id: string; repository_id: string }>(evidence.runId, workspace);
  if (!run) return null;
  if (run.repository_id !== evidence.repositoryId || run.session_id !== evidence.sessionId) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Profile memory source identity mismatch');
  }
  const session = readAkinatorSession(database, { workspace, sessionId: run.session_id });
  const link = readRunIntakeLink(database, { workspace, runId: evidence.runId });
  if (canonicalContentHash(session.profile) !== evidence.profileHash
    || canonicalContentHash({ task: session.task, sources: link.profileSources }) !== evidence.sourceHash) return null;
  return { evidence, profile: session.profile, sources: link.profileSources, ready: session.status === 'ready', completed: run.status === 'completed' };
}

/** Caller owns the transaction. No unregistered standalone sessions are projected. */
export function syncProfileDocument(database: SqliteDatabase, workspace: string, runId: string): void {
  const repository = database.prepare('SELECT repository_id FROM repositories WHERE workspace = ?').get<{ repository_id: string }>(workspace);
  if (!repository) return;
  const link = readRunIntakeLink(database, { workspace, runId });
  const session = readAkinatorSession(database, { workspace, sessionId: link.sessionId });
  database.prepare('DELETE FROM akinator_profile_documents WHERE run_id = ?').run(runId);
  if (session.status !== 'active') {
    database.prepare(`INSERT INTO akinator_profile_documents
      (run_id, session_id, workspace, repository_id, task_text, target, profile_hash, source_hash, projection_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(runId, session.id, workspace, repository.repository_id,
        session.task.slice(0, 16_384), session.profile.target ?? '', canonicalContentHash(session.profile), canonicalContentHash({ task: session.task, sources: link.profileSources }));
    const document = database.prepare('SELECT id FROM akinator_profile_documents WHERE run_id = ?').get<{ id: number }>(runId)!;
    for (const value of profileSignals(session.profile.target ?? '')) {
      database.prepare('INSERT INTO akinator_profile_signals(document_id, workspace, repository_id, value) VALUES (?, ?, ?, ?)')
        .run(document.id, workspace, repository.repository_id, value);
    }
  }
  if (database.prepare('SELECT 1 FROM akinator_profile_projection_state WHERE workspace = ?').get(workspace)) return;
  database.prepare(`INSERT OR IGNORE INTO akinator_profile_projection_state(workspace, repository_id, projection_version, cursor, complete)
    SELECT ?, ?, 1, '', CASE WHEN EXISTS (
      SELECT 1 FROM run_intakes i JOIN ledger_runs r ON r.run_id = i.run_id JOIN akinator_sessions s ON s.id = i.session_id
      LEFT JOIN akinator_profile_documents d ON d.run_id = i.run_id
      WHERE r.workspace = ? AND s.status <> 'active' AND d.id IS NULL
    ) THEN 0 ELSE 1 END`).run(workspace, repository.repository_id, workspace);
}

export function saveMemoryResolution(database: SqliteDatabase, input: { runId: string; sessionId: string; workspace: string; resolution: MemoryResolution; now: string }): void {
  const resolution = parseMemoryResolution(input.resolution);
  database.prepare(`INSERT INTO akinator_memory_resolutions(run_id, session_id, workspace, resolution_json, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(input.runId, input.sessionId, input.workspace, canonicalJson(resolution), input.now);
}
export function readMemoryResolution(database: SqliteDatabase, workspace: string, runId: string): MemoryResolution | null {
  const row = database.prepare('SELECT session_id, resolution_json FROM akinator_memory_resolutions WHERE workspace = ? AND run_id = ?')
    .get<{ session_id: string; resolution_json: string }>(workspace, runId);
  if (!row) return null;
  const link = readRunIntakeLink(database, { workspace, runId });
  if (link.sessionId !== row.session_id) throw new KiokukoError('INTEGRITY_ERROR', 'Profile memory resolution intake identity mismatch');
  try { return parseMemoryResolution(JSON.parse(row.resolution_json)); }
  catch (error) {
    if (error instanceof SyntaxError) throw new KiokukoError('INTEGRITY_ERROR', 'Stored profile memory JSON is invalid');
    throw error;
  }
}

/** A bounded batch commits its projection and progress together; resume uses saved cursor. */
export function rebuildProfileMemoryBatch(database: SqliteDatabase, input: { workspace: string; batchSize?: number; restart?: boolean }): { processed: number; complete: boolean; cursor: string } {
  const batchSize = input.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new KiokukoError('VALIDATION_ERROR', 'Profile memory batch size must be 1..1000');
  return withImmediateTransaction(database, () => {
    const repository = database.prepare('SELECT repository_id FROM repositories WHERE workspace = ?').get<{ repository_id: string }>(input.workspace);
    if (!repository) throw new KiokukoError('NOT_FOUND', 'Profile memory workspace is not registered');
    if (input.restart) {
      database.prepare('DELETE FROM akinator_profile_documents WHERE workspace = ?').run(input.workspace);
      database.prepare('DELETE FROM akinator_profile_projection_state WHERE workspace = ?').run(input.workspace);
    }
    database.prepare(`INSERT OR IGNORE INTO akinator_profile_projection_state VALUES (?, ?, 1, '', 0)`).run(input.workspace, repository.repository_id);
    const state = database.prepare('SELECT cursor, complete FROM akinator_profile_projection_state WHERE workspace = ?').get<{ cursor: string; complete: number }>(input.workspace)!;
    if (state.complete) return { processed: 0, complete: true, cursor: state.cursor };
    const rows = database.prepare(`SELECT r.run_id FROM ledger_runs r JOIN run_intakes i ON i.run_id = r.run_id
      WHERE r.workspace = ? AND r.run_id > ? ORDER BY r.run_id LIMIT ?`).all<{ run_id: string }>(input.workspace, state.cursor, batchSize);
    for (const row of rows) syncProfileDocument(database, input.workspace, row.run_id);
    const cursor = rows.at(-1)?.run_id ?? state.cursor;
    const complete = rows.length < batchSize;
    database.prepare('UPDATE akinator_profile_projection_state SET cursor = ?, complete = ? WHERE workspace = ?').run(cursor, complete ? 1 : 0, input.workspace);
    return { processed: rows.length, complete, cursor };
  });
}
