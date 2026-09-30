import { hybridSearch, type HybridSearchRuntime } from './hybrid-retrieval.js';
import * as z from 'zod/v4';
import type { SqliteDatabase } from '../db/adapter.js';
import { readEntry, type EntryRecord } from './entries.js';
import { canonicalContentHash, compareCanonicalStrings } from '../serialization/validate.js';
import { KiokukoError } from '../errors.js';
export const INDEX_TEMPLATE = 'memory-index-v1';
export type IndexMode = 'off' | 'observe' | 'active';
export interface IndexSource {
    workspace: string;
    entryId: string;
    revision: number;
    contentHash: string;
}
const sourceReferenceSchema = z.object({ workspace: z.string().min(1), entryId: z.string().min(1), revision: z.number().int().positive(), contentHash: z.string().regex(/^[0-9a-f]{64}$/u) }).strict();
const sourceBatchSchema = z.array(sourceReferenceSchema).min(1).max(5);
export function indexMode(db: SqliteDatabase, workspace: string): IndexMode {
    return db.prepare('SELECT mode FROM memory_index_settings WHERE workspace=?').get<{
        mode: IndexMode;
    }>(workspace)?.mode ?? 'off';
}
export function isIndexArtifact(entry: EntryRecord): boolean { return entry.createdBy === 'kiokuko-memory-index' || entry.provenance.type === 'memory_index'; }
export function assertNotIndexArtifact(entry: EntryRecord): void {
    if (isIndexArtifact(entry))
        throw new KiokukoError('CONFLICT', 'Managed index artifacts require the memory-index workflow');
}
export function indexArtifact(db: SqliteDatabase, entry: EntryRecord) {
    if (entry.kind !== 'fact' || entry.status !== 'candidate' || entry.trustLevel !== 'untrusted' || entry.confidence > .5 || entry.createdBy !== 'kiokuko-memory-index' || entry.provenance.type !== 'memory_index')
        return undefined;
    const row = db.prepare('SELECT * FROM memory_index_artifacts WHERE entry_id=?').get<{
        entry_id: string;
        work_id: string;
        knowledge_type: 'atomic' | 'bridge';
        output_hash: string;
        sources_json: string;
        entities_json: string;
        quotes_json: string;
        state: string;
        connection: string | null;
    }>(entry.id);
    if (!row || row.output_hash !== entry.contentHash || row.state !== 'supported')
        return undefined;
    const work = db.prepare('SELECT template_version,workspace,batch_json,batch_hash FROM memory_index_work WHERE work_id=?').get<{
        template_version: string;
        workspace: string;
        batch_json: string;
        batch_hash: string;
    }>(row.work_id);
    if (work?.template_version !== INDEX_TEMPLATE || work.workspace !== entry.workspace)
        return undefined;
    try {
        const sources = sourceBatchSchema.parse(JSON.parse(row.sources_json));
        const batch = sourceBatchSchema.parse(JSON.parse(work.batch_json));
        if (canonicalContentHash(batch) !== work.batch_hash || !sources.every(source => batch.some(s => canonicalContentHash(s) === canonicalContentHash(source))))
            return undefined;
        const entities = JSON.parse(row.entities_json);
        const quotes = z.array(z.object({ entryId: z.string(), start: z.number().int().nonnegative(), end: z.number().int().positive(), text: z.string().min(1) }).strict()).min(1).max(16).parse(JSON.parse(row.quotes_json));
        if (sources.length !== (row.knowledge_type === 'atomic' ? 1 : 2) || new Set(sources.map(s => s.entryId)).size !== sources.length
            || entry.provenance.reference !== row.work_id + ':' + indexMetadataHash(row.knowledge_type, sources, entities, quotes, row.connection)
            || entry.provenance.sourceSetHash !== canonicalContentHash(sources)
            || entry.provenance.requirementScopeHash !== indexMetadataHash(row.knowledge_type, sources, entities, quotes, row.connection))
            return undefined;
        const mapped = db.prepare('SELECT source_id,source_revision FROM memory_index_sources WHERE artifact_id=? ORDER BY source_id').all<{
            source_id: string;
            source_revision: number;
        }>(entry.id);
        if (canonicalContentHash(mapped.sort((a, b) => compareCanonicalStrings(a.source_id, b.source_id))) !== canonicalContentHash(sources.map(s => ({ source_id: s.entryId, source_revision: s.revision }))))
            return undefined;
        for (const s of sources) {
            const current = readEntry(db, { workspace: s.workspace, entryId: s.entryId });
            if (s.workspace !== entry.workspace || current.revision !== s.revision || current.contentHash !== s.contentHash || current.status === 'superseded' || isIndexArtifact(current)
                || !quotes.some(q => q.entryId === s.entryId))
                return undefined;
            for (const q of quotes.filter(q => q.entryId === s.entryId))
                if (q.end <= q.start || current.body.slice(q.start, q.end) !== q.text)
                    return undefined;
        }
        if (row.knowledge_type === 'bridge' && db.prepare("SELECT 1 FROM entry_links WHERE relation='contradicts' AND ((from_entry_id=? AND to_entry_id=?) OR (from_entry_id=? AND to_entry_id=?))").get(sources[0]!.entryId, sources[1]!.entryId, sources[1]!.entryId, sources[0]!.entryId))
            return undefined;
        if (quotes.some(q => !sources.some(s => s.entryId === q.entryId)))
            return undefined;
        return { knowledgeType: row.knowledge_type, sources, quotes, connection: row.connection };
    }
    catch (error) {
        if (error instanceof SyntaxError || error instanceof z.ZodError || error instanceof KiokukoError && ['NOT_FOUND', 'INTEGRITY_ERROR', 'VALIDATION_ERROR'].includes(error.code))
            return undefined;
        throw error;
    }
}
export function indexMetadataHash(type: 'atomic' | 'bridge', sources: IndexSource[], entities: unknown, quotes: unknown, connection: string | null = null): string {
    return canonicalContentHash({ type, sources, entities, quotes, connection, template: INDEX_TEMPLATE });
}
export function indexStateHash(db: SqliteDatabase, workspaces: readonly string[]): string {
    return canonicalContentHash(workspaces.map(workspace => ({ workspace, mode: indexMode(db, workspace), template: INDEX_TEMPLATE, artifacts: db.prepare('SELECT a.* FROM memory_index_artifacts a JOIN entries e ON e.id=a.entry_id WHERE e.workspace=? ORDER BY a.entry_id').all(workspace) })));
}
/** Shadow diagnostics never alter ordinary ranking, delivery or trust. */
export function observeIndex(db: SqliteDatabase, workspace: string, query: string, runtime: HybridSearchRuntime = {}) {
    if (indexMode(db, workspace) !== 'observe')
        return undefined;
    const started = performance.now();
    const ranked = hybridSearch(db, { workspace, query, limit: 120, indexEvaluation: true }, runtime);
    const generated = ranked.flatMap((hit, index) => {
        const entry = readEntry(db, { workspace, entryId: hit.entryId });
        const artifact = indexArtifact(db, entry);
        return artifact ? [{ entryId: entry.id, knowledgeType: artifact.knowledgeType, rank: index + 1, score: hit.fusedScore, sources: artifact.sources }] : [];
    });
    return { mode: 'observe' as const, candidates: ranked.length, generated, elapsedMs: performance.now() - started, deliveredGeneratedCount: 0 as const };
}
/** Apply before vector top-k so disabled artifacts cannot displace originals. */
export function indexVectorFilter(evaluation: boolean, originalsOnly = false): string {
    if (originalsOnly)
        return "e.created_by <> 'kiokuko-memory-index' AND COALESCE(json_extract(r.provenance_json,'$.type'),'') <> 'memory_index'";
    return `((e.created_by <> 'kiokuko-memory-index' AND COALESCE(json_extract(r.provenance_json,'$.type'),'') <> 'memory_index') OR EXISTS(SELECT 1 FROM memory_index_artifacts a JOIN memory_index_settings ims ON ims.workspace=e.workspace WHERE a.entry_id=e.id AND a.state='supported' AND (ims.mode='active' OR ${evaluation ? '1' : '0'})))`;
}
export function validIndexVector(db: SqliteDatabase, workspace: string, entryId: string): boolean {
    try {
        return indexArtifact(db, readEntry(db, { workspace, entryId })) !== undefined;
    }
    catch (error) {
        if (error instanceof KiokukoError && ['NOT_FOUND', 'INTEGRITY_ERROR', 'VALIDATION_ERROR'].includes(error.code))
            return false;
        throw error;
    }
}
export function formatIndexSourceReferences(artifact: NonNullable<ReturnType<typeof indexArtifact>>): string {
    return `\n\nSources: ${JSON.stringify(artifact.sources)}\nQuotes: ${JSON.stringify(artifact.quotes)}${artifact.connection ? `\nConnection: ${artifact.connection}` : ''}`;
}
