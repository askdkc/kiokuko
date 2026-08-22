import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { extractEntrySearchSignals, syncEntrySearchSignals } from './structured-memory.js';
import type { JsonObject } from '../serialization/validate.js';

interface EntryProjectionRow extends SqliteRow {
  rowid: number;
  id: string;
  title: string;
  body: string;
  summary: string | null;
  scope_json: string;
}

function scope(value: string): JsonObject {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

export function rebuildHybridSearch(database: SqliteDatabase): { entries: number; signals: number } {
  const hasFts = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'entries_fts'").get();
  const hasTrigram = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'entries_trigram'").get();
  const hasSignals = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'entry_search_signals'").get();
  if (!hasFts && !hasTrigram && !hasSignals) return { entries: 0, signals: 0 };
  if (hasFts) {
    database.exec('DELETE FROM entries_fts');
    database.prepare(`
      INSERT INTO entries_fts(rowid, title, body, summary, tags_text)
      SELECT e.rowid, r.title, r.body, COALESCE(r.summary, ''),
             COALESCE((SELECT group_concat(tag, ' ') FROM entry_revision_tags WHERE entry_id = e.id AND revision = e.current_revision), '')
        FROM entries e JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision
    `).run();
  }
  if (hasTrigram) {
    database.exec('DELETE FROM entries_trigram');
    database.prepare(`
      INSERT INTO entries_trigram(rowid, title, body, summary, tags_text)
      SELECT e.rowid, r.title, r.body, COALESCE(r.summary, ''),
             COALESCE((SELECT group_concat(tag, ' ') FROM entry_revision_tags WHERE entry_id = e.id AND revision = e.current_revision), '')
        FROM entries e JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision
    `).run();
  }
  if (hasSignals) {
    database.exec('DELETE FROM entry_search_signals');
    const rows = database.prepare(`
      SELECT e.id, r.title, r.body, r.summary, r.scope_json
        FROM entries e JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision
       ORDER BY e.id
    `).all<EntryProjectionRow>();
    for (const row of rows) {
      const tags = database.prepare('SELECT tag FROM entry_revision_tags WHERE entry_id = ? AND revision = (SELECT current_revision FROM entries WHERE id = ?) ORDER BY tag').all<{ tag: string }>(row.id, row.id).map((tag) => tag.tag);
      syncEntrySearchSignals(database, { entryId: row.id, title: row.title, body: row.body, summary: row.summary, tags, scope: scope(row.scope_json) });
    }
  }
  const entries = Number(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count ?? 0);
  const signals = hasSignals ? Number(database.prepare('SELECT COUNT(*) AS count FROM entry_search_signals').get<{ count: number }>()?.count ?? 0) : 0;
  return { entries, signals };
}

export function hybridSearchProjectionStatus(database: SqliteDatabase): {
  trigram: number;
  signals: number;
  entries: number;
  missingSignals: number;
  extraSignals: number;
  staleTrigram: number;
} {
  const entries = Number(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count ?? 0);
  const hasTrigram = Boolean(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'entries_trigram'").get());
  const hasSignals = Boolean(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE name = 'entry_search_signals'").get());
  const trigram = hasTrigram ? Number(database.prepare('SELECT COUNT(*) AS count FROM entries_trigram').get<{ count: number }>()?.count ?? 0) : 0;
  const signals = hasSignals ? Number(database.prepare('SELECT COUNT(*) AS count FROM entry_search_signals').get<{ count: number }>()?.count ?? 0) : 0;
  let missingSignals = 0;
  let extraSignals = 0;
  let staleTrigram = hasTrigram ? Math.abs(trigram - entries) : 0;
  if (hasSignals || hasTrigram) {
    const rows = database.prepare(`
      SELECT e.rowid, e.id, r.title, r.body, r.summary, r.scope_json
        FROM entries e JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision
       ORDER BY e.id
    `).all<EntryProjectionRow>();
    for (const row of rows) {
      const tags = database.prepare('SELECT tag FROM entry_revision_tags WHERE entry_id = ? AND revision = (SELECT current_revision FROM entries WHERE id = ?) ORDER BY tag').all<{ tag: string }>(row.id, row.id).map((tag) => tag.tag);
      if (hasSignals) {
        const expected = new Set(extractEntrySearchSignals({ entryId: row.id, title: row.title, body: row.body, summary: row.summary, tags, scope: scope(row.scope_json) }).map((signal) => `${signal.type}\u0000${signal.value}`));
        const actual = new Set(database.prepare('SELECT signal_type, normalized_value FROM entry_search_signals WHERE entry_id = ?').all<{ signal_type: string; normalized_value: string }>(row.id).map((signal) => `${signal.signal_type}\u0000${signal.normalized_value}`));
        for (const signal of expected) if (!actual.has(signal)) missingSignals += 1;
        for (const signal of actual) if (!expected.has(signal)) extraSignals += 1;
      }
      if (hasTrigram) {
        const projected = database.prepare('SELECT title, body, summary, tags_text FROM entries_trigram WHERE rowid = ?').get<{ title: string; body: string; summary: string; tags_text: string }>(row.rowid);
        const expectedTags = tags.join(' ');
        if (!projected || projected.title !== row.title || projected.body !== row.body || projected.summary !== (row.summary ?? '') || projected.tags_text !== expectedTags) staleTrigram += 1;
      }
    }
  }
  return { entries, trigram, signals, missingSignals, extraSignals, staleTrigram };
}
