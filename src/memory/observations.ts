import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { observationSchema, memoryContextSchema, type MemoryContextResponse, type MemoryContextItem, type MemoryRecordResponse } from './observation-contract.js';
import { readEntry, type EntryRecord } from './entries.js';
import { resolveProjectWorkspace, GLOBAL_WORKSPACE } from './workspaces.js';
import { recallEntries } from './retrieval.js';

interface Head extends SqliteRow { workspace: string; producer: string; source_id: string; source_revision: number;
  content_hash: string; ledger_event_id: string; entry_id: string; session_id: string; kind: string;
  tombstone: number; payload_json: string; updated_at: string; }
const failure = (warning: string) => ({ accepted: false, recorded: false, workMayContinue: true as const, warnings: [warning] });
function contextItem(entry: EntryRecord, scope: 'project' | 'global'): MemoryContextItem {
  let body: Record<string, unknown> = {};
  try { const decoded: unknown = JSON.parse(entry.body); if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) body = decoded as Record<string, unknown>; } catch { /* Legacy prose is advisory. */ }
  const value = body.verification;
  const actions = observationSchema.shape.actions.safeParse(body.actions);
  return { entryId: entry.id, revision: entry.revision, kind: entry.kind, summary: entry.summary ?? entry.body.slice(0, 2048),
    tags: entry.tags, confidence: entry.confidence,
    verification: value === 'passed' || value === 'failed' ? value : 'unknown',
    verificationProvenance: value === 'passed' || value === 'failed' ? 'declared' : 'unknown',
    sourceEventIds: Array.isArray(entry.provenance.evidenceIds) ? entry.provenance.evidenceIds.filter((id): id is string => typeof id === 'string') : [],
    ...(actions.success ? { actions: actions.data } : {}),
    ...(typeof body.issue === 'string' ? { issue: body.issue } : {}),
    ...(typeof body.prevention === 'string' ? { prevention: body.prevention } : {}),
    scope, untrusted: true };
}
export async function memoryContext(db: SqliteDatabase, raw: unknown): Promise<MemoryContextResponse> {
  const empty = (warning: string): MemoryContextResponse => ({ available: false, workMayContinue: true,
    entries: [], handoff: null, warnings: [warning] });
  try {
    const parsed = memoryContextSchema.safeParse(raw);
    if (!parsed.success) return empty('memory_input_invalid');
    const input = parsed.data, project = await resolveProjectWorkspace(db, input.cwd);
    if (!project) return empty('memory_repository_unavailable');
    const rows = recallEntries(db, { workspace: project.workspace, query: input.query, limit: 50, maxChars: 48000, ...(input.tags[0] ? { tag: input.tags[0].toLowerCase() } : {}) });
    const entries: MemoryContextItem[] = [];
    for (const hit of rows.items) {
      const entry = readEntry(db, { workspace: project.workspace, entryId: hit.id });
      if (['passive_observation','principle_candidate'].includes(String(entry.provenance.type))) continue;
      const head = db.prepare('SELECT tombstone,kind FROM memory_observation_heads WHERE entry_id=?').get<{ tombstone: number; kind: string }>(entry.id);
      if (head?.tombstone || (head && ['model_switch', 'compaction'].includes(head.kind)) || input.tags.some(tag => !entry.tags.includes(tag.toLowerCase()))) continue;
      entries.push(contextItem(entry, 'project'));
    }
    const handoff = null; // Legacy passive handoffs have no user-save approval.
    return { available: true, workMayContinue: true, entries: entries.slice(0, input.limit), handoff, warnings: [] };
  } catch { return empty('memory_context_unavailable'); }
}
/** Passive events and maintenance are suggestions, never permission to save derived memories. */
export async function observeMemory(_db: SqliteDatabase, raw: unknown): Promise<MemoryRecordResponse> {
  if (!observationSchema.safeParse(raw).success) return failure('memory_input_invalid');
  return failure('post_task_review_required');
}
export async function improveMemory(_db: SqliteDatabase, _raw: unknown): Promise<MemoryRecordResponse> {
  return failure('post_task_review_required');
}
