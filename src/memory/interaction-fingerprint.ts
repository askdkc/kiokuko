import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { canonicalContentHash, canonicalTagOrder } from '../serialization/validate.js';
import { readEntry, type EntryRecord } from './entries.js';
import { INTERACTION_SOURCE } from './interaction-subjects.js';

type FactFields = Pick<EntryRecord, 'workspace' | 'kind' | 'title' | 'body' | 'summary' | 'scope' | 'tags'>;

/** Provenance and confidence deliberately do not define the identity of a fact. */
export function interactionFingerprint(entry: FactFields): string {
  return canonicalContentHash({ version: 1, workspace: entry.workspace, kind: entry.kind,
    title: entry.title.normalize('NFKC').trim(), body: entry.body.normalize('NFKC').trim(),
    summary: entry.summary?.normalize('NFKC').trim() ?? null,
    scope: entry.scope, tags: canonicalTagOrder(entry.tags) });
}

/** Called inside the writer's transaction after the current revision and tags exist. */
export function syncInteractionFingerprint(database: SqliteDatabase, entry: EntryRecord): void {
  // Existing records are not silently reclassified as interaction memories.
  if (entry.provenance.type !== INTERACTION_SOURCE) return;
  database.prepare('DELETE FROM interaction_memory_fingerprints WHERE entry_id = ?').run(entry.id);
  if (entry.status === 'superseded') return;
  database.prepare(`INSERT INTO interaction_memory_fingerprints(entry_id, workspace, revision, fingerprint)
    VALUES (?, ?, ?, ?)`).run(entry.id, entry.workspace, entry.revision, interactionFingerprint(entry));
}

export function findInteractionDuplicate(database: SqliteDatabase, input: FactFields): EntryRecord | undefined {
  const fingerprint = interactionFingerprint(input);
  const rows = database.prepare(`SELECT entry_id, revision FROM interaction_memory_fingerprints
    WHERE workspace = ? AND fingerprint = ? ORDER BY entry_id LIMIT 2`)
    .all<{ entry_id: string; revision: number }>(input.workspace, fingerprint);
  const entries = rows.map((row) => {
    const entry = readEntry(database, { workspace: input.workspace, entryId: row.entry_id });
    if (entry.revision !== row.revision || entry.status === 'superseded'
      || entry.provenance.type !== INTERACTION_SOURCE || interactionFingerprint(entry) !== fingerprint) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Interaction memory fingerprint is stale');
    }
    return entry;
  });
  return entries[0];
}

export function rebuildInteractionFingerprintsInTransaction(database: SqliteDatabase): number {
  const rows = database.prepare(`SELECT e.id, e.workspace FROM entries e JOIN entry_revisions r
    ON r.entry_id = e.id AND r.revision = e.current_revision
    WHERE json_extract(r.provenance_json, '$.type') = ? ORDER BY e.id`)
    .all<{ id: string; workspace: string }>(INTERACTION_SOURCE);
  const entries = rows.map((row) => readEntry(database, { workspace: row.workspace, entryId: row.id }));
  database.exec('DELETE FROM interaction_memory_fingerprints');
  for (const entry of entries) syncInteractionFingerprint(database, entry);
  return entries.filter((entry) => entry.status !== 'superseded').length;
}
