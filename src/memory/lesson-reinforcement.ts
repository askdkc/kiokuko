import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash } from '../serialization/validate.js';
import type { EntryRecord } from './entries.js';

export type LessonReinforcement = {
  independentRuns: number;
  priority: 'normal' | 'reinforced';
};

/** Titles, subjects and transport provenance do not change the identity of a lesson. */
function lessonFingerprint(entry: EntryRecord): string | null {
  if (entry.kind !== 'lesson' || entry.status === 'superseded'
    || entry.scope.visibility !== 'project' || entry.workspace === 'global'
    || !['interaction_capture', 'agent_checkpoint'].includes(String(entry.provenance.type))) return null;
  return canonicalContentHash({ version: 1, workspace: entry.workspace,
    body: entry.body.normalize('NFKC').trim(), applicability: entry.scope.applicability ?? null });
}

/** Current-revision observations only; repeated reports confer priority, never trust. */
export function lessonReinforcement(database: SqliteDatabase, entry: EntryRecord): LessonReinforcement {
  const fingerprint = lessonFingerprint(entry);
  const independentRuns = fingerprint === null ? 0 : database.prepare(
    'SELECT COUNT(*) AS count FROM lesson_observations WHERE fingerprint = ?',
  ).get<{ count: number }>(fingerprint)!.count;
  return { independentRuns, priority: independentRuns >= 2 ? 'reinforced' : 'normal' };
}

/** Record one observation per logical root run inside the capture/checkpoint transaction. */
export function observeLessonInTransaction(database: SqliteDatabase, entry: EntryRecord, runId: string, now: string) {
  const fingerprint = lessonFingerprint(entry);
  const before = lessonReinforcement(database, entry);
  if (fingerprint === null) return { ...before, promoted: false };
  let rootId = runId;
  const visited = new Set<string>();
  while (true) {
    if (visited.has(rootId) || visited.size >= 64) throw new KiokukoError('INTEGRITY_ERROR', 'Lesson run ancestry is invalid');
    visited.add(rootId);
    const run = database.prepare('SELECT workspace, parent_run_id FROM ledger_runs WHERE run_id = ?')
      .get<{ workspace: string; parent_run_id: string | null }>(rootId);
    if (!run || run.workspace !== entry.workspace) throw new KiokukoError('CONFLICT', 'Lesson observation belongs to another project');
    if (run.parent_run_id === null) break;
    rootId = run.parent_run_id;
  }
  database.prepare(`INSERT INTO lesson_observations(fingerprint, run_id, entry_id, entry_revision, created_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(fingerprint, run_id) DO NOTHING`)
    .run(fingerprint, rootId, entry.id, entry.revision, now);
  const after = lessonReinforcement(database, entry);
  return { ...after, promoted: before.priority === 'normal' && after.priority === 'reinforced' };
}
