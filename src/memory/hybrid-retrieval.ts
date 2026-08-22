import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { parseRetrievalQuery, normalizeSearchSignal, type ParsedRetrievalQuery } from './retrieval-query.js';
import type { EntryKind, EntryStatus } from '../serialization/validate.js';

export type RetrievalLane = 'exact-signal' | 'word-fts' | 'trigram' | 'like' | 'tag';

export interface HybridSearchInput {
  workspace: string;
  query: string;
  limit: number;
  kind?: EntryKind;
  status?: EntryStatus;
  tag?: string;
  includeSuperseded?: boolean;
}

export interface RetrievalCandidate {
  entryId: string;
  fusedScore: number;
  laneRanks: Partial<Record<RetrievalLane, number>>;
  matchedSignals: string[];
  reasons: string[];
}

interface SearchRow extends SqliteRow {
  id: string;
  score?: number;
}

const MAX_LANE_CANDIDATES = 120;
const MAX_MERGED_CANDIDATES = 1_000;
const RRF_K = 60;
const LANE_WEIGHTS: Record<RetrievalLane, number> = {
  'exact-signal': 5,
  'word-fts': 1,
  trigram: 1.5,
  like: 0.75,
  tag: 3,
};

function invalid(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Search query is invalid');
}

function hasTable(database: SqliteDatabase, name: string): boolean {
  return Boolean(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ?").get(name));
}

function quotedFts(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function escapedLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function filterSql(input: HybridSearchInput, parameters: Array<string | number>): string {
  const clauses = ['e.workspace = ?'];
  parameters.push(input.workspace);
  if (!input.includeSuperseded) clauses.push("e.status <> 'superseded'");
  if (input.kind !== undefined) {
    clauses.push('r.kind = ?');
    parameters.push(input.kind);
  }
  if (input.status !== undefined) {
    clauses.push('e.status = ?');
    parameters.push(input.status);
  }
  if (input.tag !== undefined) {
    clauses.push('EXISTS (SELECT 1 FROM entry_revision_tags filter_tags WHERE filter_tags.entry_id = e.id AND filter_tags.revision = e.current_revision AND filter_tags.tag = ?)');
    parameters.push(input.tag);
  }
  return clauses.join(' AND ');
}

function rankSql(): string {
  return `CASE e.status WHEN 'verified' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END,
    CASE e.trust_level WHEN 'system_verified' THEN 0 WHEN 'source_verified' THEN 1 WHEN 'user_asserted' THEN 2 ELSE 3 END,
    e.confidence DESC, e.updated_at DESC, e.id ASC`;
}

function exactSignalLane(database: SqliteDatabase, input: HybridSearchInput, parsed: ParsedRetrievalQuery): SearchRow[] {
  if (!hasTable(database, 'entry_search_signals')) return [];
  const values = parsed.exactSignals.map((signal) => signal.normalizedValue).filter(Boolean).slice(0, 32);
  if (values.length === 0) return [];
  const parameters: Array<string | number> = [input.workspace, ...values];
  const filters = filterSql(input, parameters);
  parameters.push(MAX_LANE_CANDIDATES);
  return database.prepare(`
    SELECT e.id, COUNT(*) AS score
    FROM entry_search_signals AS s
    JOIN entries AS e ON e.id = s.entry_id
    JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision
    WHERE e.workspace = ? AND s.normalized_value IN (${values.map(() => '?').join(', ')}) AND ${filters}
    GROUP BY e.id
    ORDER BY score DESC, ${rankSql()}
    LIMIT ?
  `).all<SearchRow>(...parameters);
}

function tagLane(database: SqliteDatabase, input: HybridSearchInput, parsed: ParsedRetrievalQuery): SearchRow[] {
  const values = [...new Set([
    ...parsed.lexicalTerms,
    ...parsed.exactSignals.map((signal) => signal.value),
  ].map(normalizeSearchSignal).filter((value) => value.length > 1))].slice(0, 32);
  if (values.length === 0) return [];
  const parameters: Array<string | number> = [];
  const filters = filterSql(input, parameters);
  const tagParameters = values.map(() => '?').join(', ');
  parameters.unshift(...values);
  parameters.push(MAX_LANE_CANDIDATES);
  return database.prepare(`
    SELECT e.id, COUNT(*) AS score
    FROM entry_revision_tags AS t
    JOIN entries AS e ON e.id = t.entry_id AND e.current_revision = t.revision
    JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision
    WHERE lower(t.tag) IN (${tagParameters}) AND ${filters}
    GROUP BY e.id
    ORDER BY score DESC, ${rankSql()}
    LIMIT ?
  `).all<SearchRow>(...parameters);
}

function wordFtsLane(database: SqliteDatabase, input: HybridSearchInput, parsed: ParsedRetrievalQuery): SearchRow[] {
  if (!hasTable(database, 'entries_fts')) return [];
  const values = [...new Set([...parsed.lexicalTerms, ...parsed.phraseTerms])]
    .filter((value) => value.length > 0)
    .slice(0, 24);
  const rows: SearchRow[] = [];
  for (const value of values) {
    const parameters: Array<string | number> = [quotedFts(value)];
    const filters = filterSql(input, parameters);
    parameters.push(MAX_LANE_CANDIDATES);
    try {
      rows.push(...database.prepare(`
        SELECT e.id, bm25(entries_fts) AS score
        FROM entries_fts JOIN entries e ON e.rowid = entries_fts.rowid
        JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision
        WHERE entries_fts MATCH ? AND ${filters}
        ORDER BY score ASC, ${rankSql()}
        LIMIT ?
      `).all<SearchRow>(...parameters));
    } catch (error) {
      if (!(error instanceof Error) || !/fts|match|syntax/i.test(error.message)) throw error;
    }
  }
  return rows;
}

function trigramLane(database: SqliteDatabase, input: HybridSearchInput, parsed: ParsedRetrievalQuery): SearchRow[] {
  if (!hasTable(database, 'entries_trigram')) return [];
  const values = parsed.substringTerms.filter((value) => value.length >= 2).slice(0, 24);
  const rows: SearchRow[] = [];
  for (const value of values) {
    const parameters: Array<string | number> = [quotedFts(value)];
    const filters = filterSql(input, parameters);
    parameters.push(MAX_LANE_CANDIDATES);
    try {
      rows.push(...database.prepare(`
        SELECT e.id, bm25(entries_trigram) AS score
        FROM entries_trigram JOIN entries e ON e.rowid = entries_trigram.rowid
        JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision
        WHERE entries_trigram MATCH ? AND ${filters}
        ORDER BY score ASC, ${rankSql()}
        LIMIT ?
      `).all<SearchRow>(...parameters));
    } catch (error) {
      if (!(error instanceof Error) || !/fts|match|syntax/i.test(error.message)) throw error;
    }
  }
  return rows;
}

function likeLane(database: SqliteDatabase, input: HybridSearchInput, parsed: ParsedRetrievalQuery): SearchRow[] {
  const values = [...new Set([
    ...parsed.exactSignals.map((signal) => signal.value),
    ...parsed.substringTerms,
  ])].filter((value) => value.length > 1).slice(0, 12);
  if (values.length === 0) return [];
  const result = new Map<string, SearchRow>();
  for (const value of values) {
    const pattern = `%${escapedLike(value)}%`;
    const parameters: Array<string | number> = [pattern, pattern, pattern, pattern];
    const filters = filterSql(input, parameters);
    parameters.push(MAX_LANE_CANDIDATES);
    const rows = database.prepare(`
      SELECT e.id, 0 AS score FROM entries AS e
      JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision
      WHERE (r.title LIKE ? ESCAPE '\\' OR r.body LIKE ? ESCAPE '\\' OR COALESCE(r.summary, '') LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM entry_revision_tags t WHERE t.entry_id = e.id AND t.revision = e.current_revision AND t.tag LIKE ? ESCAPE '\\'))
        AND ${filters}
      ORDER BY ${rankSql()} LIMIT ?
    `).all<SearchRow>(...parameters);
    for (const row of rows) result.set(row.id, row);
  }
  return [...result.values()];
}

function laneRows(database: SqliteDatabase, input: HybridSearchInput, parsed: ParsedRetrievalQuery): Array<[RetrievalLane, SearchRow[]]> {
  return [
    ['exact-signal', exactSignalLane(database, input, parsed)],
    ['word-fts', wordFtsLane(database, input, parsed)],
    ['trigram', trigramLane(database, input, parsed)],
    ['like', likeLane(database, input, parsed)],
    ['tag', tagLane(database, input, parsed)],
  ];
}

export function hybridSearch(database: SqliteDatabase, input: HybridSearchInput): RetrievalCandidate[] {
  if (typeof input.workspace !== 'string' || input.workspace.trim().length === 0) invalid();
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) invalid();
  const parsed = parseRetrievalQuery(input.query);
  if (parsed.normalized.length === 0) return [];
  // Treat SQL/FTS-looking operator soup as data, not as a broad OR query. A
  // punctuation-heavy request must never turn into a full-table lexical scan.
  if (/(?:--|\/\*|\*\/|["']\s*(?:OR|AND)\b|\b(?:OR|AND)\s+\d+\s*[=<>])/iu.test(parsed.normalized) && parsed.exactSignals.length === 0) return [];
  const merged = new Map<string, RetrievalCandidate>();
  for (const [lane, rows] of laneRows(database, input, parsed)) {
    const seen = new Set<string>();
    let rank = 0;
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rank += 1;
      const existing = merged.get(row.id) ?? { entryId: row.id, fusedScore: 0, laneRanks: {}, matchedSignals: [], reasons: [] };
      existing.fusedScore += LANE_WEIGHTS[lane] / (RRF_K + rank);
      existing.laneRanks[lane] = Math.min(existing.laneRanks[lane] ?? rank, rank);
      if (lane === 'exact-signal') existing.reasons.push('exact_signal_match');
      if (lane === 'word-fts') existing.reasons.push('word_match');
      if (lane === 'trigram') existing.reasons.push('substring_match');
      if (lane === 'like') existing.reasons.push('literal_fallback_match');
      if (lane === 'tag') existing.reasons.push('tag_match');
      existing.matchedSignals.push(...parsed.exactSignals.map((signal) => signal.value));
      merged.set(row.id, existing);
      if (merged.size >= MAX_MERGED_CANDIDATES) break;
    }
  }
  return [...merged.values()]
    .map((candidate) => ({
      ...candidate,
      matchedSignals: [...new Set(candidate.matchedSignals)].sort(),
      reasons: [...new Set(candidate.reasons)].sort(),
    }))
    .sort((left, right) => right.fusedScore - left.fusedScore || left.entryId.localeCompare(right.entryId));
}

export function hybridSearchRows(database: SqliteDatabase, input: HybridSearchInput): { rows: SearchRow[]; truncated: boolean } {
  const candidates = hybridSearch(database, input);
  const rows = candidates.slice(0, input.limit).map(({ entryId: id, fusedScore: score }) => ({ id, score }));
  return { rows, truncated: candidates.length > input.limit };
}
