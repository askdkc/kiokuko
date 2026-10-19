import { KiokukoError } from '../errors.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { readEntry, type EntryRecord } from './entries.js';
import { matchesMemoryApplicability, evaluateMemoryApplicability, type ApplicabilityState, type MemoryApplicabilityContext } from './applicability-context.js';
export const MAX_HISTORY_NODES = 64;
export interface HistoryOmission {
    reason: 'depth_cap' | 'node_cap' | 'missing_history' | 'scope_unknown' | 'scope_incompatible' | 'environment_unknown' | 'environment_incompatible' | 'output_budget' | 'not_evaluated';
    count?: number;
    disposition?: 'omitted' | 'not_evaluated';
}
export interface EntryHistoryItem {
    entryId: string;
    workspace: string;
    revision: number;
    supersededBy: string;
    status: 'superseded';
    title: string;
    body: string;
    applicability: ApplicabilityState;
    untrusted: true;
    instructions: false;
}
/** Follow only an exact workspace/owner/applicability chain; never infer a successor from a title or path. */
export function resolveCurrentSuccessor(db: SqliteDatabase, entry: EntryRecord, context: MemoryApplicabilityContext, maxDepth = MAX_HISTORY_NODES, onOmission?: (value: HistoryOmission) => void): EntryRecord | undefined {
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_HISTORY_NODES)
        throw new KiokukoError('VALIDATION_ERROR', 'History depth bound is invalid');
    const seen = new Set<string>();
    let current = entry;
    for (let depth = 0; depth < maxDepth; depth++) {
        if (seen.has(current.id)) {
            onOmission?.({ reason: 'missing_history', disposition: 'omitted' });
            return undefined;
        }
        if (!matchesMemoryApplicability(current, context))
            return undefined;
        seen.add(current.id);
        if (current.status !== 'superseded')
            return current;
        const next = db.prepare('SELECT id FROM entries WHERE id=? AND workspace=?').get<{
            id: string;
        }>(current.supersededBy, current.workspace);
        if (!next) {
            onOmission?.({ reason: 'missing_history', disposition: 'omitted' });
            return undefined;
        }
        current = readEntry(db, { workspace: entry.workspace, entryId: next.id });
    }
    onOmission?.({ reason: 'depth_cap', disposition: 'not_evaluated' });
    return undefined;
}
/** Bounded reverse traversal preserves immutable evidence separately from active recall. */
export function readEntryAncestry(db: SqliteDatabase, workspace: string, seeds: readonly string[], context: MemoryApplicabilityContext, maxNodes = MAX_HISTORY_NODES): {
    items: EntryHistoryItem[];
    omissions: HistoryOmission[];
} {
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > MAX_HISTORY_NODES)
        throw new KiokukoError('VALIDATION_ERROR', 'History node bound is invalid');
    const items: EntryHistoryItem[] = [], omissions: HistoryOmission[] = [], seen = new Set(seeds);
    let frontier = [...new Set(seeds)], reads = 0;
    for (let depth = 0; frontier.length && depth < MAX_HISTORY_NODES; depth++) {
        const next: string[] = [];
        for (const id of frontier) {
            const rows = db.prepare("SELECT id FROM entries WHERE workspace=? AND superseded_by=? AND status='superseded' ORDER BY id LIMIT ?").all<{
                id: string;
            }>(workspace, id, maxNodes + 1);
            for (const row of rows) {
                if (reads++ >= 256) {
                    omissions.push({ reason: 'node_cap', disposition: 'not_evaluated' });
                    return { items, omissions };
                }
                if (seen.has(row.id))
                    continue;
                seen.add(row.id);
                const entry = readEntry(db, { workspace, entryId: row.id });
                if (!matchesMemoryApplicability(entry, context))
                    continue;
                if (items.length >= maxNodes) {
                    omissions.push({ reason: 'node_cap', disposition: 'omitted' });
                    return { items, omissions };
                }
                items.push({ entryId: entry.id, workspace, revision: entry.revision, supersededBy: entry.supersededBy!, status: 'superseded', title: entry.title, body: entry.body, applicability: evaluateMemoryApplicability(entry, context).state, untrusted: true, instructions: false });
                next.push(entry.id);
            }
        }
        frontier = next;
    }
    if (frontier.length)
        omissions.push({ reason: 'depth_cap', disposition: 'not_evaluated' });
    return { items, omissions };
}
