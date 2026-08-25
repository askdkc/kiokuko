import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { readEntry } from './entries.js';
import { decodeStoredStructuredScope } from './revisions.js';
import { extractEntrySearchSignals, requireHybridSearchProjectionSchema } from './structured-memory.js';

interface EntryOwnerRow extends SqliteRow {
  rowid: unknown;
  id: unknown;
  workspace: unknown;
}

interface PreparedEntryProjection {
  rowid: number;
  entryId: string;
  title: string;
  body: string;
  summary: string;
  tagsText: string;
  signals: Array<{ type: string; value: string }>;
}

function integrity(message = 'Stored search projection source is invalid'): never {
  throw new KiokukoError('INTEGRITY_ERROR', message);
}

function preparedProjections(database: SqliteDatabase): PreparedEntryProjection[] {
  const entryCount = database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: unknown }>()?.count;
  if (typeof entryCount !== 'number' || !Number.isSafeInteger(entryCount) || entryCount < 0) integrity();
  const rows = database.prepare('SELECT rowid, id, workspace FROM entries ORDER BY id').all<EntryOwnerRow>();
  if (rows.length !== entryCount) integrity('A current entry revision is missing');
  return rows.map((row) => {
    if (typeof row.rowid !== 'number' || !Number.isSafeInteger(row.rowid) || row.rowid < 1
      || typeof row.id !== 'string' || row.id.length === 0
      || typeof row.workspace !== 'string' || row.workspace.length === 0) integrity();
    let entry: ReturnType<typeof readEntry>;
    try {
      entry = readEntry(database, { workspace: row.workspace, entryId: row.id });
    } catch (error) {
      if (error instanceof KiokukoError
        && (error.code === 'VALIDATION_ERROR' || error.code === 'NOT_FOUND')) integrity();
      throw error;
    }
    const scope = decodeStoredStructuredScope(entry.scope).canonicalScope;
    return {
      rowid: row.rowid,
      entryId: row.id,
      title: entry.title,
      body: entry.body,
      summary: entry.summary ?? '',
      tagsText: entry.tags.join(' '),
      signals: extractEntrySearchSignals({
        entryId: row.id,
        title: entry.title,
        body: entry.body,
        summary: entry.summary,
        tags: entry.tags,
        scope,
      }),
    };
  });
}

/** Rebuild while participating in a transaction already owned by the caller. */
export function rebuildHybridSearchInTransaction(database: SqliteDatabase): { entries: number; signals: number } {
  requireHybridSearchProjectionSchema(database);
  const projections = preparedProjections(database);
  const expectedSignals = projections.reduce((count, projection) => count + projection.signals.length, 0);

  database.exec('DELETE FROM entries_fts');
  database.exec('DELETE FROM entries_trigram');
  database.exec('DELETE FROM entry_search_signals');

  const insertFts = database.prepare('INSERT INTO entries_fts (rowid, title, body, summary, tags_text) VALUES (?, ?, ?, ?, ?)');
  const insertTrigram = database.prepare('INSERT INTO entries_trigram (rowid, title, body, summary, tags_text) VALUES (?, ?, ?, ?, ?)');
  const insertSignal = database.prepare('INSERT INTO entry_search_signals (entry_id, signal_type, normalized_value) VALUES (?, ?, ?)');
  for (const projection of projections) {
    const parameters = [projection.rowid, projection.title, projection.body, projection.summary, projection.tagsText] as const;
    insertFts.run(...parameters);
    insertTrigram.run(...parameters);
    for (const signal of projection.signals) insertSignal.run(projection.entryId, signal.type, signal.value);
  }

  const ftsCount = database.prepare('SELECT COUNT(*) AS count FROM entries_fts').get<{ count: unknown }>()?.count;
  const trigramCount = database.prepare('SELECT COUNT(*) AS count FROM entries_trigram').get<{ count: unknown }>()?.count;
  const signalCount = database.prepare('SELECT COUNT(*) AS count FROM entry_search_signals').get<{ count: unknown }>()?.count;
  if (ftsCount !== projections.length || trigramCount !== projections.length || signalCount !== expectedSignals) {
    integrity('Hybrid search projection rebuild produced an incomplete result');
  }
  return { entries: projections.length, signals: expectedSignals };
}

export function rebuildHybridSearch(database: SqliteDatabase): { entries: number; signals: number } {
  return withImmediateTransaction(database, () => rebuildHybridSearchInTransaction(database));
}

export function hybridSearchProjectionStatus(database: SqliteDatabase): {
  trigram: number;
  signals: number;
  entries: number;
  missingSignals: number;
  extraSignals: number;
  staleTrigram: number;
} {
  requireHybridSearchProjectionSchema(database);
  const projections = preparedProjections(database);
  const storedCount = (table: 'entries_trigram' | 'entry_search_signals'): number => {
    const count = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get<{ count: unknown }>()?.count;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) integrity();
    return count;
  };
  const entries = projections.length;
  const trigram = storedCount('entries_trigram');
  const signals = storedCount('entry_search_signals');
  let missingSignals = 0;
  let extraSignals = 0;
  let staleTrigram = Math.abs(trigram - entries);
  for (const projection of projections) {
    const expected = new Set(projection.signals.map((signal) => `${signal.type}\u0000${signal.value}`));
    const actual = new Set(database.prepare('SELECT signal_type, normalized_value FROM entry_search_signals WHERE entry_id = ?').all<{ signal_type: string; normalized_value: string }>(projection.entryId).map((signal) => `${signal.signal_type}\u0000${signal.normalized_value}`));
    for (const signal of expected) if (!actual.has(signal)) missingSignals += 1;
    for (const signal of actual) if (!expected.has(signal)) extraSignals += 1;
    const projected = database.prepare('SELECT title, body, summary, tags_text FROM entries_trigram WHERE rowid = ?').get<{ title: unknown; body: unknown; summary: unknown; tags_text: unknown }>(projection.rowid);
    if (!projected
      || projected.title !== projection.title
      || projected.body !== projection.body
      || projected.summary !== projection.summary
      || projected.tags_text !== projection.tagsText) staleTrigram += 1;
  }
  return { entries, trigram, signals, missingSignals, extraSignals, staleTrigram };
}
