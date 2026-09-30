import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { readEntry, type EntryRecord } from './entries.js';
import { requireWorkspace, type EntryKind, type EntryStatus } from '../serialization/validate.js';
import { hybridSearch, type HybridSearchRuntime } from './hybrid-retrieval.js';
import type { TemporalConstraint } from './temporal.js';
import type { RelatedSearchMode } from './hybrid-retrieval.js';
import { readRerankerConfig } from '../reranker/config.js';
import { rerankCandidateRecords, type RerankerDiagnostics } from '../reranker/service.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { deduplicateDeliverableLessonSources, formatLessonSourceReferences, type LessonDeduplicationResult } from './lesson-derivation.js';
import { effectiveRelatedSearchMode } from './search-extension-config.js';

export interface SearchEntriesInput {
  workspace: string;
  query: string;
  limit?: number;
  kind?: EntryKind;
  status?: EntryStatus;
  tag?: string;
  includeSuperseded?: boolean;
  subjects?: readonly string[];
  temporal?: TemporalConstraint;
  relatedMode?: RelatedSearchMode;
  relatedSeedLimit?: number;
  relatedCandidateLimit?: number;
}

export interface SearchResult {
  items: EntryRecord[];
  count: number;
  truncated: boolean;
  rerankerDiagnostics?: RerankerDiagnostics;
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
  selectionReasons?: string[];
}

export interface RecallResult {
  items: RecallItem[];
  count: number;
  characterCount: number;
  truncated: boolean;
  rerankerDiagnostics?: RerankerDiagnostics;
  lessonDeduplicationDiagnostics?: LessonDeduplicationResult['diagnostics'];
}

export interface RankedRecallHit {
  entryId: string;
  retrievalScore: number;
  rank: number;
  reasons: string[];
}

export interface RankedRecallResult {
  hits: RankedRecallHit[];
  truncated: boolean;
}

const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_RECALL_LIMIT = 5;
const DEFAULT_RECALL_MAX_CHARS = 8000;
const MAX_LIMIT = 1000;
const MAX_RECALL_CHARS = 100_000;

function characterCount(value: string): number {
  return Array.from(value).length;
}

function takeCharacters(value: string, limit: number): string {
  return Array.from(value).slice(0, Math.max(0, limit)).join('');
}

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

export function rankedEntryHits(
  database: SqliteDatabase,
  input: SearchEntriesInput,
  runtime: HybridSearchRuntime = {},
): RankedRecallResult {
  const limit = normalizedLimit(input.limit, DEFAULT_SEARCH_LIMIT);
  const workspace = requireWorkspace(input.workspace);
  const normalizedInput = { ...input, workspace };
  if (normalizedInput.query.trim().length === 0) return { hits: [], truncated: false };

  const candidates = hybridSearch(database, { ...normalizedInput, limit }, runtime);
  return {
    hits: candidates.slice(0, limit).map((candidate, index) => ({
      entryId: candidate.entryId,
      retrievalScore: Number((candidate.fusedScore * 100).toFixed(6)),
      rank: index + 1,
      reasons: [...candidate.reasons],
    })),
    truncated: candidates.length > limit,
  };
}

export function searchEntries(
  database: SqliteDatabase,
  input: SearchEntriesInput,
  runtime: HybridSearchRuntime = {},
): SearchResult {
  const limit = normalizedLimit(input.limit, DEFAULT_SEARCH_LIMIT);
  const selected = rankedEntryHits(database, { ...input, limit }, runtime);
  const items = selected.hits.map((hit) => readEntry(database, { workspace: input.workspace, entryId: hit.entryId }));
  return { items, count: items.length, truncated: selected.truncated };
}

function candidateSnapshotHash(items: readonly EntryRecord[]): string {
  return canonicalContentHash(items.map((entry) => ({
    id: entry.id,
    workspace: entry.workspace,
    revision: entry.revision,
    contentHash: entry.contentHash,
    status: entry.status,
    trustLevel: entry.trustLevel,
    scope: entry.scope,
  })));
}

export async function searchEntriesWithReranker(
  database: SqliteDatabase,
  input: SearchEntriesInput,
  runtime: HybridSearchRuntime = {},
  signal?: AbortSignal,
): Promise<SearchResult> {
  const baseline = searchEntries(database, input, runtime);
  const config = readRerankerConfig();
  if (config.mode === 'off') return baseline;
  const originalHash = candidateSnapshotHash(baseline.items);
  const keyed = baseline.items.map((entry) => ({
    key: entry.id, entry, title: entry.title, summary: entry.summary, body: entry.body,
  }));
  const reranked = await rerankCandidateRecords(input.query, keyed, config, signal);
  const current = searchEntries(database, input, runtime);
  if (candidateSnapshotHash(current.items) !== originalHash) {
    throw new KiokukoError('CONFLICT', 'Search selection changed during reranker inference');
  }
  return {
    ...baseline,
    items: reranked.candidates.map(({ entry }) => entry),
    ...(reranked.diagnostics === undefined ? {} : { rerankerDiagnostics: reranked.diagnostics }),
  };
}

export function recallEntries(
  database: SqliteDatabase,
  input: RecallEntriesInput,
  runtime: HybridSearchRuntime = {},
): RecallResult {
  const limit = normalizedLimit(input.limit, DEFAULT_RECALL_LIMIT);
  const maxChars = normalizedMaxChars(input.maxChars);
  const selected = rankedEntryHits(database, { ...input, limit }, runtime);
  const entries = selected.hits.map((row) => readEntry(database, { workspace: input.workspace, entryId: row.entryId }));
  const relatedMode = effectiveRelatedSearchMode(input.relatedMode);
  const deduplicated = deduplicateDeliverableLessonSources(database, entries, relatedMode);
  const suppressed = new Set(deduplicated.suppressed.map((item) => item.entryId));
  const retained = new Set(deduplicated.suppressed.map((item) => item.retainedEntryId));
  const sourceNotes = new Map<string, string>();
  if (relatedMode === 'active') {
    for (const [entryId, references] of deduplicated.sourceReferences) sourceNotes.set(entryId, formatLessonSourceReferences(references));
  }
  const reasons = new Map<string, string[]>();
  for (const id of retained) reasons.set(id, ['duplicate_source_suppressed']);
  return {
    ...packRecallEntries(input, deduplicated.entries, selected.truncated || suppressed.size > 0, maxChars, sourceNotes, reasons),
    lessonDeduplicationDiagnostics: deduplicated.diagnostics,
  };
}

function packRecallEntries(
  input: RecallEntriesInput,
  entries: readonly EntryRecord[],
  selectedTruncated: boolean,
  maxChars = normalizedMaxChars(input.maxChars),
  sourceNotes: ReadonlyMap<string, string> = new Map(),
  selectionReasons: ReadonlyMap<string, string[]> = new Map(),
): RecallResult {
  const items: RecallItem[] = [];
  let characters = 0;
  let truncated = false;

  for (const entry of entries) {
    const sourceNote = sourceNotes.get(entry.id) ?? '';
    const baseSource = entry.summary ?? entry.body;
    const fullSource = `${baseSource}${sourceNote}`;
    const titleCost = characterCount(entry.title) + 1;
    const remaining = maxChars - characters - titleCost;
    if (remaining <= 0 || sourceNote.length > 0 && remaining < characterCount(sourceNote)) {
      truncated = true;
      continue;
    }
    const snippet = sourceNote.length === 0
      ? takeCharacters(baseSource, remaining)
      : `${takeCharacters(baseSource, remaining - characterCount(sourceNote))}${sourceNote}`;
    if (characterCount(snippet) < characterCount(fullSource)
      || characterCount(entry.body) > characterCount(snippet)) truncated = true;
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
      ...(selectionReasons.get(entry.id) === undefined ? {} : { selectionReasons: [...selectionReasons.get(entry.id)!] }),
    });
    characters += titleCost + characterCount(snippet);
    if (characters >= maxChars) break;
  }

  if (items.length < entries.length || selectedTruncated) truncated = true;
  return { items, count: items.length, characterCount: characters, truncated };
}

export async function recallEntriesWithReranker(
  database: SqliteDatabase,
  input: RecallEntriesInput,
  runtime: HybridSearchRuntime = {},
  signal?: AbortSignal,
): Promise<RecallResult> {
  const config = readRerankerConfig();
  if (config.mode === 'off') return recallEntries(database, input, runtime);
  const limit = normalizedLimit(input.limit, DEFAULT_RECALL_LIMIT);
  const maxChars = normalizedMaxChars(input.maxChars);
  const baseline = searchEntries(database, { ...input, limit }, runtime);
  const relatedMode = effectiveRelatedSearchMode(input.relatedMode);
  const deduplicated = deduplicateDeliverableLessonSources(database, baseline.items, relatedMode);
  const suppressed = new Set(deduplicated.suppressed.map((item) => item.entryId));
  const retained = new Set(deduplicated.suppressed.map((item) => item.retainedEntryId));
  const sourceNotes = new Map<string, string>();
  if (relatedMode === 'active') {
    for (const [entryId, references] of deduplicated.sourceReferences) sourceNotes.set(entryId, formatLessonSourceReferences(references));
  }
  const reasons = new Map<string, string[]>();
  for (const id of retained) reasons.set(id, ['duplicate_source_suppressed']);
  const originalHash = canonicalContentHash({
    entries: candidateSnapshotHash(deduplicated.entries),
    sourceReferences: [...deduplicated.sourceReferences.entries()],
  });
  const keyed = deduplicated.entries.map((entry) => ({
    key: entry.id, entry, title: entry.title, summary: entry.summary, body: `${entry.body}${sourceNotes.get(entry.id) ?? ''}`,
  }));
  const reranked = await rerankCandidateRecords(input.query, keyed, config, signal);
  const current = searchEntries(database, { ...input, limit }, runtime);
  const currentDedupe = deduplicateDeliverableLessonSources(database, current.items, relatedMode);
  if (canonicalContentHash({
    entries: candidateSnapshotHash(currentDedupe.entries),
    sourceReferences: [...currentDedupe.sourceReferences.entries()],
  }) !== originalHash) {
    throw new KiokukoError('CONFLICT', 'Recall selection changed during reranker inference');
  }
  const result = packRecallEntries(input, reranked.candidates.map(({ entry }) => entry), baseline.truncated || suppressed.size > 0, maxChars, sourceNotes, reasons);
  return {
    ...result,
    lessonDeduplicationDiagnostics: deduplicated.diagnostics,
    ...(reranked.diagnostics === undefined ? {} : { rerankerDiagnostics: reranked.diagnostics }),
  };
}
