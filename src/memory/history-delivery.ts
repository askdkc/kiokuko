import type { SqliteDatabase } from '../db/adapter.js';
import { withDeferredReadTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { currentMemoryApplicability, assertMemoryApplicabilityUnchanged, matchesMemoryApplicability } from './applicability-context.js';
import { readEntryAncestry, type EntryHistoryItem, type HistoryOmission } from './entry-history.js';
import { readCodeVersions, type CodeVersionView } from './code-versions.js';
import { readEntry } from './entries.js';
import { restrictRelationDelivery } from './relation-delivery.js';
export const DEFAULT_HISTORY_OUTPUT_CHARACTERS = 32000;
export class HistoryOutputBudgetError extends KiokukoError {
    constructor(minimumCharacters: number) { super('VALIDATION_ERROR', 'Final recall budget cannot fit its explicit envelope and omission status', { reason: 'output_budget_too_small', minimumCharacters }); }
}
export interface OutputDelivery {
    characterBudget: number;
    unit: 'unicode_code_points';
    scope: 'serialized_response';
    status: 'complete' | 'omitted_budget';
}
export interface HistoryDelivery {
    scope: 'provided_items';
    status: 'complete' | 'partial' | 'not_evaluated';
    ancestors: EntryHistoryItem[];
    codeVersions: CodeVersionView[];
    omissions: HistoryOmission[];
    storedData: true;
    untrusted: true;
    instructions: false;
    executionPermission: false;
}
interface RecallItemIdentity {
    id: string;
    workspace: string;
    title: string;
    snippet: string;
    revision?: number;
}
interface RecallPacket {
    historySelectionOmissions?: HistoryOmission[];
    items: RecallItemIdentity[];
    count: number;
    characterCount: number;
    truncated: boolean;
    relationDelivery?: unknown;
    historyDelivery?: HistoryDelivery;
    outputDelivery?: OutputDelivery;
}
export interface HistoryRecallOptions {
    workspace: string;
    cwd?: string;
    includeHistory?: boolean;
    maxOutputChars?: number;
    measure?: (value: object) => number;
}
const count = (value: object) => Array.from(JSON.stringify(value)).length;
export function readHistoryDelivery(db: SqliteDatabase, workspace: string, entryIds: readonly string[], cwd?: string, expectedRevisions?: ReadonlyMap<string, number>): HistoryDelivery {
    const context = currentMemoryApplicability(db, workspace, cwd);
    if (entryIds.length > 1000)
        throw new KiokukoError('VALIDATION_ERROR', 'Too many history seeds');
    const read = () => {
        const validIds = entryIds.filter(entryId => {
            const entry = readEntry(db, { workspace, entryId });
            if (entry.status === 'superseded' || expectedRevisions?.has(entryId) && entry.revision !== expectedRevisions.get(entryId))
                throw new KiokukoError('CONFLICT', 'Active history seed changed during retrieval');
            return matchesMemoryApplicability(entry, context);
        });
        const history = readEntryAncestry(db, workspace, validIds, context);
        const versions = readCodeVersions(db, context, [...new Set([...validIds, ...history.items.map(x => x.entryId)])]);
        assertMemoryApplicabilityUnchanged(db, context, cwd);
        const omissions = [...history.omissions, ...versions.omissions];
        return { scope: 'provided_items' as const, status: entryIds.length === 0 ? 'not_evaluated' as const : omissions.some(o => o.reason !== 'not_evaluated') ? 'partial' as const : 'complete' as const,
            ancestors: history.items, codeVersions: versions.items, omissions, storedData: true as const, untrusted: true as const, instructions: false as const, executionPermission: false as const };
    };
    return withDeferredReadTransaction(db, read);
}
/** Bound the FINAL representation, including optional consumer envelopes, rather than counting body snippets alone. */
export function finalizeHistoryRecall<T extends RecallPacket>(db: SqliteDatabase, value: T, options: HistoryRecallOptions): T & {
    historyDelivery?: HistoryDelivery;
    outputDelivery?: OutputDelivery;
} {
    if (!options.includeHistory && options.maxOutputChars === undefined)
        return value;
    const budget = options.maxOutputChars ?? DEFAULT_HISTORY_OUTPUT_CHARACTERS;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 1000000)
        throw new KiokukoError('VALIDATION_ERROR', 'Final recall budget must be an integer between 1 and 1000000');
    const measure = options.measure ?? count;
    let result = { ...value, items: [...value.items], outputDelivery: { characterBudget: budget, unit: 'unicode_code_points' as const, scope: 'serialized_response' as const, status: 'complete' as const }, ...(options.includeHistory ? { historyDelivery: readHistoryDelivery(db, options.workspace, value.items.filter(i => i.workspace === options.workspace).map(i => i.id), options.cwd, new Map(value.items.flatMap(i => i.revision === undefined ? [] : [[i.id, i.revision]]))) } : {}) } as T & {
        historyDelivery?: HistoryDelivery;
        outputDelivery?: OutputDelivery;
    };
    if (result.historyDelivery && value.historySelectionOmissions?.length)
        result.historyDelivery = { ...result.historyDelivery, status: 'partial', omissions: [...result.historyDelivery.omissions, ...value.historySelectionOmissions] };
    const original = value.items.map(item => ({ entryId: item.id, workspace: item.workspace, ...(item.revision === undefined ? {} : { revision: item.revision }) }));
    const mark = () => {
        result.truncated = true;
        result.outputDelivery = { characterBudget: budget, unit: 'unicode_code_points', scope: 'serialized_response', status: 'omitted_budget' };
        if (result.historyDelivery) {
            result.historyDelivery = { ...result.historyDelivery, status: 'partial', omissions: [...result.historyDelivery.omissions.filter(o => o.reason !== 'output_budget'), { reason: 'output_budget', disposition: 'omitted' }] };
        }
    };
    while (measure(result) > budget && result.historyDelivery && (result.historyDelivery.codeVersions.length || result.historyDelivery.ancestors.length)) {
        mark();
        const history = result.historyDelivery!;
        result.historyDelivery = history.codeVersions.length ? { ...history, codeVersions: history.codeVersions.slice(0, -1) } : { ...history, ancestors: history.ancestors.slice(0, -1) };
    }
    if (measure(result) > budget && result.items.length) {
        mark();
        const base = result;
        const prefix = (length: number) => {
            const items = value.items.slice(0, length), packet = { ...base, items, count: items.length,
                characterCount: items.reduce((sum, item) => sum + Array.from(item.title).length + 1 + Array.from(item.snippet).length, 0) };
            if (value.relationDelivery !== undefined)
                packet.relationDelivery = restrictRelationDelivery(value.relationDelivery, original, items.map(item => ({ entryId: item.id, workspace: item.workspace, ...(item.revision === undefined ? {} : { revision: item.revision }) })), { selectionOmissions: ['final_filter'] });
            if (packet.historyDelivery)
                packet.historyDelivery = { ...packet.historyDelivery, ancestors: [], codeVersions: [] };
            return packet as typeof result;
        };
        let low = 0, high = result.items.length, best = prefix(0);
        while (low <= high) {
            const middle = Math.floor((low + high) / 2), candidate = prefix(middle);
            if (measure(candidate) <= budget) {
                best = candidate;
                low = middle + 1;
            }
            else
                high = middle - 1;
        }
        result = best;
    }
    if (measure(result) > budget)
        throw new HistoryOutputBudgetError(measure(result));
    return result;
}
