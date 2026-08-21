import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { readEntry, type EntryRecord } from './entries.js';
import { requireWorkspace, type EntryKind, type EntryStatus } from '../serialization/validate.js';
import { hybridSearchRows } from './hybrid-retrieval.js';

export interface SearchEntriesInput {
  workspace: string;
  query: string;
  limit?: number;
  kind?: EntryKind;
  status?: EntryStatus;
  tag?: string;
  includeSuperseded?: boolean;
}

export interface SearchResult {
  items: EntryRecord[];
  count: number;
  truncated: boolean;
}

export interface RecallEntriesInput extends SearchEntriesInput {
  maxChars?: number;
}

export interface RecallItem {
  id: string;
  workspace: string;
  kind: EntryKind;
  status: EntryStatus;
  title: string;
  summary: string | null;
  snippet: string;
  tags: string[];
  metadata: {
    storedData: true;
    untrusted: true;
    instructions: false;
  };
}

export interface RecallResult {
  items: RecallItem[];
  count: number;
  characterCount: number;
  truncated: boolean;
}

interface SearchRow extends SqliteRow {
  id: string;
  score?: number;
}

const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_RECALL_LIMIT = 5;
const DEFAULT_RECALL_MAX_CHARS = 8000;
const MAX_LIMIT = 1000;
const MAX_RECALL_CHARS = 100_000;

function normalizedLimit(value: number | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new KiokukoError('VALIDATION_ERROR', `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return value;
}

function normalizedMaxChars(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RECALL_MAX_CHARS;
  if (!Number.isInteger(value) || value < 1 || value > MAX_RECALL_CHARS) {
    throw new KiokukoError('VALIDATION_ERROR', `maxChars must be an integer between 1 and ${MAX_RECALL_CHARS}`);
  }
  return value;
}

function hasTable(database: SqliteDatabase, name: string): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?")
      .get<{ present: number }>(name),
  );
}

function ftsQuery(query: string): string | undefined {
  const tokens = query
    .trim()
    .split(/\s+/u)
    .map((token) => token.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replaceAll('"', '""')}"`);
  return tokens.length > 0 ? tokens.join(' ') : undefined;
}

function filterSql(input: SearchEntriesInput, parameters: Array<string | number>): string {
  const clauses = ['e.workspace = ?'];
  parameters.push(input.workspace);
  if (!input.includeSuperseded) clauses.push("e.status <> 'superseded'");
  if (input.kind) {
    clauses.push('e.kind = ?');
    parameters.push(input.kind);
  }
  if (input.status) {
    clauses.push('e.status = ?');
    parameters.push(input.status);
  }
  if (input.tag) {
    clauses.push('EXISTS (SELECT 1 FROM tags filter_tags WHERE filter_tags.entry_id = e.id AND filter_tags.tag = ?)');
    parameters.push(input.tag);
  }
  return clauses.join(' AND ');
}

function rankingSql(): string {
  return `
    CASE e.status WHEN 'verified' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
    CASE e.trust_level
      WHEN 'system_verified' THEN 0
      WHEN 'source_verified' THEN 1
      WHEN 'user_asserted' THEN 2
      ELSE 3
    END,
    e.confidence DESC,
    e.updated_at DESC,
    e.id ASC`;
}

function searchWithFts(database: SqliteDatabase, input: SearchEntriesInput, limit: number, match: string): SearchRow[] {
  const parameters: Array<string | number> = [match];
  const filters = filterSql(input, parameters);
  parameters.push(limit);
  return database
    .prepare(
      `SELECT e.id, bm25(entries_fts) AS score
       FROM entries_fts
       JOIN entries e ON e.rowid = entries_fts.rowid
       WHERE entries_fts MATCH ? AND ${filters}
       ORDER BY score ASC, ${rankingSql()}
       LIMIT ?`,
    )
    .all<SearchRow>(...parameters);
}

function searchWithLike(database: SqliteDatabase, input: SearchEntriesInput, limit: number): SearchRow[] {
  const parameters: Array<string | number> = [];
  const filters = filterSql(input, parameters);
  const pattern = `%${input.query.trim()}%`;
  parameters.unshift(pattern, pattern, pattern, pattern);
  parameters.push(limit);
  return database
    .prepare(
       `SELECT e.id, 0 AS score
       FROM entries e
       WHERE (
         e.title LIKE ?
         OR e.body LIKE ?
         OR COALESCE(e.summary, '') LIKE ?
         OR EXISTS (
           SELECT 1 FROM tags like_tags
           WHERE like_tags.entry_id = e.id AND like_tags.tag LIKE ?
         )
       )
         AND ${filters}
       ORDER BY ${rankingSql()}
       LIMIT ?`,
    )
    .all<SearchRow>(...parameters);
}

function selectRows(database: SqliteDatabase, input: SearchEntriesInput, limit: number): { rows: SearchRow[]; truncated: boolean } {
  const workspace = requireWorkspace(input.workspace);
  const normalizedInput = { ...input, workspace };
  if (normalizedInput.query.trim().length === 0) return { rows: [], truncated: false };

  try {
    return hybridSearchRows(database, { ...normalizedInput, limit });
  } catch (error) {
    if (!(error instanceof KiokukoError) || error.code !== 'VALIDATION_ERROR') throw error;
  }

  const match = ftsQuery(normalizedInput.query);
  if (match && hasTable(database, 'entries_fts')) {
    try {
      const rows = searchWithFts(database, normalizedInput, limit + 1, match);
      return { rows: rows.slice(0, limit), truncated: rows.length > limit };
    } catch (error) {
      if (!(error instanceof Error) || !/fts|match|syntax/i.test(error.message)) throw error;
    }
  }
  const rows = searchWithLike(database, normalizedInput, limit + 1);
  return { rows: rows.slice(0, limit), truncated: rows.length > limit };
}

export function searchEntries(database: SqliteDatabase, input: SearchEntriesInput): SearchResult {
  const limit = normalizedLimit(input.limit, DEFAULT_SEARCH_LIMIT);
  const selected = selectRows(database, input, limit);
  const items = selected.rows.map((row) => readEntry(database, { workspace: input.workspace, entryId: row.id }));
  return { items, count: items.length, truncated: selected.truncated };
}

function recallSnippet(entry: EntryRecord, remaining: number): string {
  const source = entry.summary ?? entry.body;
  if (remaining <= 0) return '';
  return source.slice(0, remaining);
}

export function recallEntries(database: SqliteDatabase, input: RecallEntriesInput): RecallResult {
  const limit = normalizedLimit(input.limit, DEFAULT_RECALL_LIMIT);
  const maxChars = normalizedMaxChars(input.maxChars);
  const selected = selectRows(database, input, limit);
  const rows = selected.rows;
  const items: RecallItem[] = [];
  let characterCount = 0;
  let truncated = false;

  for (const row of rows) {
    const entry = readEntry(database, { workspace: input.workspace, entryId: row.id });
    const fullSource = entry.summary ?? entry.body;
    const titleCost = entry.title.length + 1;
    const remaining = maxChars - characterCount - titleCost;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const snippet = recallSnippet(entry, remaining);
    if (snippet.length < fullSource.length || entry.body.length > snippet.length) truncated = true;
    items.push({
      id: entry.id,
      workspace: entry.workspace,
      kind: entry.kind,
      status: entry.status,
      title: entry.title,
      summary: entry.summary,
      snippet,
      tags: entry.tags,
      metadata: { storedData: true, untrusted: true, instructions: false },
    });
    characterCount += titleCost + snippet.length;
    if (characterCount >= maxChars) break;
  }

  if (items.length < rows.length || selected.truncated) truncated = true;
  return { items, count: items.length, characterCount, truncated };
}
