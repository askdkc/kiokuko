import { createHash } from 'node:crypto';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { LedgerStore } from '../ledger/store.js';
import { canonicalJson } from '../serialization/validate.js';
import { readEntry, recordEntryInTransaction, type EntryRecord } from './entries.js';
import { memoryDeriveLessonInputSchema } from './interaction-contract.js';
import { findSecretInValue } from './secrets.js';
import { resolveProjectWorkspaceReadOnly } from './workspaces.js';

interface DerivationOperationRow extends SqliteRow {
  input_hash: string;
  workspace: string;
  output_entry_id: string;
  output_revision: number;
  output_content_hash: string;
  delivery_id: string;
}

interface DerivationStateRow extends SqliteRow {
  current_revision: number;
  status: string;
}

export interface DeriveLessonOptions {
  cwd: string;
  clientKind: string;
  mode?: 'off' | 'observe' | 'active';
  now?: () => string;
}

export interface LessonSourceReference extends SqliteRow {
  workspace: string;
  entryId: string;
  revision: number;
  contentHash: string;
  role: 'experience' | 'counterexample' | 'correction' | 'evidence';
}

export interface LessonDeduplicationResult {
  readonly entries: EntryRecord[];
  readonly sourceReferences: ReadonlyMap<string, readonly LessonSourceReference[]>;
  readonly suppressed: readonly { entryId: string; revision: number; retainedEntryId: string; retainedRevision: number }[];
  readonly diagnostics: { mode: 'off' | 'observe' | 'active'; candidateCount: number; duplicatePairs: number; suppressedCount: number };
}

function conflict(message: string): never {
  throw new KiokukoError('CONFLICT', message);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Only lessons with intact, revision-current source receipts may be delivered. */
export function isDeliverableDerivedLesson(database: SqliteDatabase, entry: EntryRecord): boolean {
  if (entry.provenance.type !== 'agent_derived_lesson') return true;
  if (entry.status === 'superseded') return false;
  const row = database.prepare(`
    SELECT o.operation_id, o.input_hash, o.run_id, o.delivery_id, o.workspace,
           o.output_entry_id, o.output_revision, o.output_content_hash
      FROM lesson_derivation_operations o
      JOIN lesson_derivation_sources s ON s.operation_id = o.operation_id
     WHERE o.output_entry_id = ? AND o.output_revision = ? AND o.workspace = ?
     GROUP BY o.operation_id
     ORDER BY o.operation_id ASC
  `).all<DerivationOperationRow & { operation_id: string; run_id: string }>(entry.id, entry.revision, entry.workspace);
  return row.some((operation) => operation.output_content_hash === entry.contentHash
    && entry.provenance.runId === operation.run_id
    && entry.provenance.deliveryId === operation.delivery_id
    && currentSourceIsValidForOperation(database, operation));
}

export function readDeliverableLessonSourceReferences(database: SqliteDatabase, entry: EntryRecord): LessonSourceReference[] {
  if (entry.provenance.type !== 'agent_derived_lesson' || entry.status === 'superseded') return [];
  const operations = database.prepare(`
    SELECT o.operation_id, o.input_hash, o.run_id, o.delivery_id, o.workspace,
           o.output_entry_id, o.output_revision, o.output_content_hash
      FROM lesson_derivation_operations o
     WHERE o.output_entry_id = ? AND o.output_revision = ? AND o.workspace = ?
     ORDER BY o.operation_id ASC
  `).all<DerivationOperationRow & { operation_id: string; run_id: string }>(entry.id, entry.revision, entry.workspace);
  for (const operation of operations) {
    if (operation.output_content_hash !== entry.contentHash
      || entry.provenance.runId !== operation.run_id
      || entry.provenance.deliveryId !== operation.delivery_id
      || !currentSourceIsValidForOperation(database, operation)) continue;
    return database.prepare(`
      SELECT source_workspace AS workspace, source_entry_id AS entryId,
             source_revision AS revision, source_content_hash AS contentHash, source_role AS role
        FROM lesson_derivation_sources
       WHERE operation_id = ?
       ORDER BY source_entry_id, source_revision
    `).all<LessonSourceReference>(operation.operation_id);
  }
  return [];
}

function sameLessonPayload(left: EntryRecord, right: EntryRecord): boolean {
  const semanticScope = (entry: EntryRecord): Record<string, unknown> => {
    const value = { ...entry.scope };
    delete value.schemaVersion;
    return value;
  };
  return left.workspace === right.workspace && left.kind === right.kind
    && left.title === right.title && left.summary === right.summary && left.body === right.body
    && canonicalJson(left.tags) === canonicalJson(right.tags)
    && canonicalJson(semanticScope(left)) === canonicalJson(semanticScope(right));
}

function hasContradictionLink(database: SqliteDatabase, left: string, right: string): boolean {
  return database.prepare(`SELECT 1 AS present FROM entry_links
    WHERE relation = 'contradicts'
      AND ((from_entry_id = ? AND to_entry_id = ?) OR (from_entry_id = ? AND to_entry_id = ?))
    LIMIT 1`).get<{ present: number }>(left, right, right, left) !== undefined;
}

/** Suppress only an exact duplicate that is co-deliverable with its revision-verified source. */
export function deduplicateDeliverableLessonSources(
  database: SqliteDatabase,
  candidates: readonly EntryRecord[],
  mode: 'off' | 'observe' | 'active',
): LessonDeduplicationResult {
  const byRevision = new Map(candidates.map((entry) => [`${entry.workspace}\u0000${entry.id}\u0000${entry.revision}`, entry]));
  const sourceReferences = new Map<string, readonly LessonSourceReference[]>();
  if (mode !== 'off') {
    for (const entry of candidates) {
      const references = readDeliverableLessonSourceReferences(database, entry);
      if (references.length > 0) sourceReferences.set(entry.id, references);
    }
  }
  const suppressed = new Map<string, { entryId: string; revision: number; retainedEntryId: string; retainedRevision: number }>();
  const trustRank = (entry: EntryRecord): number => ({ system_verified: 4, source_verified: 3, user_asserted: 2, untrusted: 1 })[entry.trustLevel];
  const statusRank = (entry: EntryRecord): number => ({ verified: 2, candidate: 1, superseded: 0 })[entry.status];
  let duplicatePairs = 0;
  for (const derived of candidates) {
    const references = sourceReferences.get(derived.id);
    if (references === undefined || references.length !== 1) continue;
    const reference = references[0]!;
    if (reference.role !== 'experience' && reference.role !== 'evidence') continue;
    const source = byRevision.get(`${reference.workspace}\u0000${reference.entryId}\u0000${reference.revision}`);
    if (source === undefined || !sameLessonPayload(derived, source)
      || hasContradictionLink(database, derived.id, source.id)) continue;
    duplicatePairs += 1;
    const keepSource = statusRank(source) > statusRank(derived)
      || statusRank(source) === statusRank(derived) && trustRank(source) > trustRank(derived);
    const removed = keepSource ? derived : source;
    const retained = keepSource ? source : derived;
    suppressed.set(removed.id, { entryId: removed.id, revision: removed.revision,
      retainedEntryId: retained.id, retainedRevision: retained.revision });
  }
  const suppressedItems = [...suppressed.values()];
  return {
    entries: mode === 'active' ? candidates.filter((entry) => !suppressed.has(entry.id)) : [...candidates],
    sourceReferences,
    suppressed: suppressedItems,
    diagnostics: { mode, candidateCount: candidates.length, duplicatePairs, suppressedCount: mode === 'active' ? suppressedItems.length : 0 },
  };
}

export function formatLessonSourceReferences(references: readonly LessonSourceReference[]): string {
  if (references.length === 0) return '';
  return `\n\nRevision-verified sources:\n${references.map((source) =>
    `- ${source.workspace}/${source.entryId}@${source.revision} sha256:${source.contentHash} (${source.role})`).join('\n')}`;
}

function currentSourceIsValidForOperation(
  database: SqliteDatabase,
  operation: DerivationOperationRow & { operation_id: string; run_id: string },
): boolean {
  const sources = database.prepare(`
    SELECT s.source_workspace, s.source_entry_id, s.source_revision, s.source_content_hash,
           e.workspace, e.current_revision, e.status, r.content_hash,
           EXISTS (
             SELECT 1 FROM context_delivery_entries d
              WHERE d.delivery_id = ? AND d.entry_id = s.source_entry_id
                AND d.entry_revision = s.source_revision
           ) AS delivered
      FROM lesson_derivation_sources s
      LEFT JOIN entries e ON e.id = s.source_entry_id
      LEFT JOIN entry_revisions r ON r.entry_id = s.source_entry_id AND r.revision = s.source_revision
     WHERE s.operation_id = ?
     ORDER BY s.source_entry_id, s.source_revision
  `).all<{
    source_workspace: string;
    source_entry_id: string;
    source_revision: number;
    source_content_hash: string;
    workspace: string | null;
    current_revision: number | null;
    status: string | null;
    content_hash: string | null;
    delivered: number;
  }>(operation.delivery_id, operation.operation_id);
  if (sources.length === 0 || sources.length > 16) return false;
  const delivery = database.prepare(`
    SELECT 1 AS present FROM context_deliveries cd
      JOIN ledger_runs lr ON lr.run_id = cd.run_id
     WHERE cd.delivery_id = ? AND cd.run_id = ? AND lr.workspace = ?
  `).get<{ present: number }>(operation.delivery_id, operation.run_id, operation.workspace);
  return delivery !== undefined && sources.every((source) =>
    source.source_workspace === operation.workspace
    && source.workspace === source.source_workspace
    && source.current_revision === source.source_revision
    && source.status !== 'superseded'
    && source.content_hash === source.source_content_hash
    && source.delivered === 1);
}

function replayReceipt(database: SqliteDatabase, operationId: string, inputHash: string) {
  const stored = database.prepare(`
    SELECT input_hash, run_id, delivery_id, workspace, output_entry_id, output_revision, output_content_hash
      FROM lesson_derivation_operations WHERE operation_id = ?
  `).get<DerivationOperationRow & { run_id: string }>(operationId);
  if (stored === undefined) return undefined;
  if (stored.input_hash !== inputHash) conflict('Derivation operation ID was reused with different input');
  const state = database.prepare('SELECT current_revision, status FROM entries WHERE id = ? AND workspace = ?')
    .get<DerivationStateRow>(stored.output_entry_id, stored.workspace);
  const output = state !== undefined && state.current_revision === stored.output_revision
    ? readEntry(database, { workspace: stored.workspace, entryId: stored.output_entry_id })
    : undefined;
  const valid = output !== undefined && output.contentHash === stored.output_content_hash
    && isDeliverableDerivedLesson(database, output);
  const availability = state === undefined ? 'unavailable'
    : state.status === 'superseded' ? 'superseded'
    : state.current_revision !== stored.output_revision ? 'changed'
    : valid ? 'current' : 'sources_invalid';
  return { operationId, entryId: stored.output_entry_id, revision: stored.output_revision,
    workspace: stored.workspace, outcome: 'replayed' as const, availability };
}

function assertWorkspaceStillBound(database: SqliteDatabase, repositoryRoot: string, workspace: string, repositoryId: string): void {
  const row = database.prepare(`
    SELECT r.workspace, r.repository_id
      FROM repository_locations l JOIN repositories r ON r.repository_id = l.repository_id
     WHERE l.canonical_root = ?
  `).get<{ workspace: string; repository_id: string }>(repositoryRoot);
  if (row?.workspace !== workspace || row.repository_id !== repositoryId) {
    conflict('Lesson project binding changed');
  }
}

/** Save a connected agent's lesson proposal as an untrusted candidate with atomic source receipts. */
export async function deriveLessonCandidate(database: SqliteDatabase, raw: unknown, options: DeriveLessonOptions) {
  const parsed = memoryDeriveLessonInputSchema.safeParse(raw);
  if (!parsed.success) throw new KiokukoError('VALIDATION_ERROR', 'Lesson derivation input is invalid');
  const input = parsed.data;
  if (findSecretInValue(input)) throw new KiokukoError('SECURITY_REJECTION', 'Lesson derivation input resembles a secret');
  const mode = options.mode ?? 'off';
  if (mode === 'off') return { enabled: false as const, mode, items: [] };
  const project = await resolveProjectWorkspaceReadOnly(database, input.cwd ?? options.cwd);
  if (project === undefined) throw new KiokukoError('NOT_FOUND', 'Lesson derivation requires a registered project workspace');
  const normalized = {
    ...input,
    lesson: { ...input.lesson, title: input.lesson.title.normalize('NFKC'), body: input.lesson.body.normalize('NFKC'),
      ...(input.lesson.summary === undefined ? {} : { summary: input.lesson.summary.normalize('NFKC') }) },
    sources: [...input.sources].sort((a, b) => a.entryId.localeCompare(b.entryId) || a.revision - b.revision),
  };
  const inputHash = digest({ normalized, runId: input.runId, deliveryId: input.deliveryId,
    workspace: project.workspace, repositoryId: project.repositoryId });
  const now = options.now?.() ?? new Date().toISOString();
  return withImmediateTransaction(database, () => {
    const replay = replayReceipt(database, input.operationId, inputHash);
    if (replay !== undefined) return replay;
    assertWorkspaceStillBound(database, project.repositoryRoot, project.workspace, project.repositoryId);
    const run = database.prepare(`
      SELECT r.workspace, r.status, r.client_kind, cd.run_id AS delivery_run_id
        FROM ledger_runs r
        JOIN run_intakes i ON i.run_id = r.run_id
        JOIN akinator_sessions s ON s.id = i.session_id
        JOIN context_deliveries cd ON cd.run_id = r.run_id AND cd.delivery_id = ?
       WHERE r.run_id = ? AND s.status IN ('ready', 'exhausted') AND i.finalized_at IS NOT NULL
    `).get<{ workspace: string; status: string; client_kind: string; delivery_run_id: string }>(input.deliveryId, input.runId);
    if (run === undefined || run.workspace !== project.workspace || run.delivery_run_id !== input.runId
      || run.status !== 'active' || run.client_kind !== options.clientKind) {
      conflict('Lesson derivation requires the active completed-intake run and its delivery in this project');
    }
    const sourceRecords = input.sources.map((source) => {
      if (source.workspace !== project.workspace) conflict('Lesson sources must belong to the active project workspace');
      const current = readEntry(database, { workspace: project.workspace, entryId: source.entryId });
      if (current.status === 'superseded' || current.revision !== source.revision || current.contentHash !== source.contentHash) {
        conflict('Lesson source revision or content hash is stale');
      }
      const delivered = database.prepare(`
        SELECT 1 AS present FROM context_delivery_entries
         WHERE delivery_id = ? AND entry_id = ? AND entry_revision = ?
      `).get<{ present: number }>(input.deliveryId, source.entryId, source.revision);
      if (delivered === undefined) conflict('Lesson source was not present in the active run delivery');
      return { input: source, entry: current };
    });
    const sourceSetHash = digest(sourceRecords.map(({ input: source }) => ({
      workspace: source.workspace, entryId: source.entryId, revision: source.revision,
      contentHash: source.contentHash, role: source.role,
    })).sort((a, b) => a.entryId.localeCompare(b.entryId) || a.revision - b.revision));
    if (mode === 'observe') return { enabled: true as const, mode, outcome: 'would_save' as const,
      sourceCount: sourceRecords.length, sourceSetHash, status: 'candidate' as const, trustLevel: 'untrusted' as const };
    const entry = recordEntryInTransaction(database, {
      workspace: project.workspace,
      kind: 'lesson', status: 'candidate', trustLevel: 'untrusted', confidence: 0.5,
      title: normalized.lesson.title, body: normalized.lesson.body,
      ...(normalized.lesson.summary === undefined ? {} : { summary: normalized.lesson.summary }),
      ...(normalized.lesson.tags === undefined ? {} : { tags: normalized.lesson.tags }),
      scope: { visibility: 'project', retrievalScope: 'project-only', repositoryId: project.repositoryId },
      provenance: { type: 'agent_derived_lesson', reference: 'context_delivery', runId: input.runId,
        deliveryId: input.deliveryId, evidenceIds: sourceRecords.map(({ entry: source }) => source.id), sourceSetHash },
      createdBy: 'kiokuko-mcp', actor: 'kiokuko-mcp',
    }, { now });
    if (sourceRecords.some(({ entry: source }) => source.id === entry.id)) {
      conflict('Lesson cannot cite itself as a source');
    }
    for (const { entry: source } of sourceRecords) {
      const cyclic = database.prepare(`
        WITH RECURSIVE reachable(id) AS (
          SELECT to_entry_id FROM entry_links WHERE from_entry_id = ? AND relation = 'derived_from'
          UNION
          SELECT link.to_entry_id FROM entry_links link JOIN reachable r ON link.from_entry_id = r.id
           WHERE link.relation = 'derived_from'
        ) SELECT 1 AS present FROM reachable WHERE id = ? LIMIT 1
      `).get<{ present: number }>(source.id, entry.id);
      if (cyclic !== undefined) conflict('Lesson derivation would create a source cycle');
    }
    database.prepare(`
      INSERT INTO lesson_derivation_operations (
        operation_id, input_hash, run_id, delivery_id, workspace,
        output_entry_id, output_revision, output_content_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.operationId, inputHash, input.runId, input.deliveryId, project.workspace,
      entry.id, entry.revision, entry.contentHash, now);
    for (const { input: source } of sourceRecords) {
      database.prepare(`
        INSERT INTO lesson_derivation_sources (
          operation_id, output_entry_id, output_revision, source_workspace,
          source_entry_id, source_revision, source_content_hash, source_role
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(input.operationId, entry.id, entry.revision, source.workspace,
        source.entryId, source.revision, source.contentHash, source.role);
      database.prepare(`
        INSERT OR IGNORE INTO entry_links (from_entry_id, to_entry_id, relation, created_at, created_by)
        VALUES (?, ?, 'derived_from', ?, 'kiokuko-mcp')
      `).run(entry.id, source.entryId, now);
    }
    new LedgerStore(database).appendBatchInTransaction(input.runId, { events: [{ eventType: 'memory.proposed', actor: 'kiokuko-mcp',
      payload: { entryId: entry.id, revision: entry.revision, scope: project.workspace, outcome: 'derived_candidate',
        deliveryId: input.deliveryId, sourceIds: sourceRecords.map(({ entry: source }) => source.id) } }] });
    return { operationId: input.operationId, entryId: entry.id, revision: entry.revision,
      workspace: entry.workspace, outcome: 'created' as const, availability: 'current' as const,
      status: entry.status, trustLevel: entry.trustLevel, reinforced: false };
  });
}
