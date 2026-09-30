import * as z from 'zod/v4';
import { randomUUID } from 'node:crypto';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { LedgerStore } from '../ledger/store.js';
import { parseAssurance } from '../assurance/contracts.js';
import { assertAssuranceCwd } from '../assurance/service.js';
import { readEntry, recordEntryInTransaction } from './entries.js';
import { canonicalContentHash, canonicalJson, compareCanonicalStrings } from '../serialization/validate.js';
import { INDEX_TEMPLATE, indexMode, isIndexArtifact, indexMetadataHash, indexArtifact, type IndexSource } from './index-state.js';
import { findSecretInValue } from './secrets.js';
const id = z.string().trim().min(1).max(256);
const entity = z.object({ kind: z.enum(['package', 'symbol', 'path', 'concept']), namespace: z.string().trim().min(1).max(256), name: z.string().trim().min(1).max(256) }).strict();
const quote = z.object({ entryId: id, start: z.number().int().nonnegative(), end: z.number().int().positive(), text: z.string().min(1).max(4000) }).strict();
const base = { cwd: z.string().min(1), runId: id, deliveryId: id, workId: id, operationId: id, expectedRevision: z.number().int().positive() };
export const indexSubmitSchema = z.object({ ...base, units: z.array(z.object({ type: z.enum(['atomic', 'bridge']), title: z.string().trim().min(1).max(200), text: z.string().trim().min(1).max(2000), sourceIds: z.array(id).min(1).max(2), entities: z.array(entity).min(1).max(16), quotes: z.array(quote).min(1).max(16), connection: z.string().trim().min(1).max(1000).optional() }).strict()).min(1).max(40) }).strict();
export const indexReviewSchema = z.object({ ...base, entryId: id, entryRevision: z.number().int().positive(), verdict: z.enum(['supported', 'unsupported', 'uncertain']), basis: z.string().trim().min(1).max(4000) }).strict();
function conflict(message: string): never { throw new KiokukoError('CONFLICT', message); }
function eligible(entry: ReturnType<typeof readEntry>): boolean { return entry.workspace !== 'global' && entry.status !== 'superseded' && entry.kind !== 'preference' && !isIndexArtifact(entry) && !['agent_derived_lesson', 'external_skill', 'source_sync'].includes(String(entry.provenance.type)); }
export function assertIndexingRunReady(db: SqliteDatabase, runId: string): void {
    if (!db.prepare("SELECT 1 FROM ledger_runs r JOIN run_intakes i ON i.run_id=r.run_id JOIN akinator_sessions s ON s.id=i.session_id WHERE r.run_id=? AND r.status='active' AND i.finalized_at IS NOT NULL AND s.status IN ('ready','exhausted')").get(runId))
        conflict('Index maintenance requires completed intake');
}
export function indexingSources(db: SqliteDatabase, workspace: string, stage: 'atomic' | 'bridge', cursor = '') {
    if (indexMode(db, workspace) === 'off')
        conflict('Enable observe before maintaining the index');
    const rows = stage === 'atomic' ? db.prepare('SELECT e.id FROM memory_index_pending p JOIN entries e ON e.id=p.entry_id WHERE e.workspace=? AND e.id>? ORDER BY e.id LIMIT 100').all<{
        id: string;
    }>(workspace, cursor) : db.prepare("SELECT DISTINCT e.id FROM entries e JOIN memory_index_sources s ON s.source_id=e.id JOIN memory_index_artifacts a ON a.entry_id=s.artifact_id WHERE e.workspace=? AND e.id>? AND a.knowledge_type='atomic' AND a.state='supported' ORDER BY e.id LIMIT 100").all<{
        id: string;
    }>(workspace, cursor);
    return rows.map(r => readEntry(db, { workspace, entryId: r.id })).filter(eligible).slice(0, 5);
}
export function createIndexWork(db: SqliteDatabase, input: {
    runId: string;
    deliveryId: string;
    workspace: string;
    stage: 'atomic' | 'bridge';
    sourceIds: string[];
    remainingCharacters?: number;
}) {
    const sources = input.sourceIds.map(entryId => {
        const e = readEntry(db, { workspace: input.workspace, entryId });
        if (!eligible(e))
            conflict('Index source is ineligible');
        return { workspace: e.workspace, entryId: e.id, revision: e.revision, contentHash: e.contentHash };
    });
    const workId = randomUUID(), expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    db.prepare('INSERT INTO memory_index_work VALUES(?,?,?,?,?,?,?,?,?)').run(workId, input.runId, input.deliveryId, input.workspace, input.stage, canonicalJson(sources), canonicalContentHash(sources), INDEX_TEMPLATE, expiresAt);
    const atomicFacts: {
        entryId: string;
        text: string;
        entities: unknown;
        sources: IndexSource[];
        untrusted: true;
    }[] = [];
    const omittedAtomicFacts: string[] = [];
    let remaining = input.remainingCharacters ?? 0;
    {
        const rows = db.prepare(`SELECT a.entry_id,a.entities_json FROM memory_index_artifacts a JOIN entries e ON e.id=a.entry_id WHERE e.workspace=? AND a.knowledge_type='atomic' AND a.state='supported' AND EXISTS(SELECT 1 FROM memory_index_sources ms WHERE ms.artifact_id=a.entry_id AND ms.source_id IN (${sources.map(() => '?').join(',') || "''"})) ORDER BY a.entry_id LIMIT 40`).all<{
            entry_id: string;
            entities_json: string;
        }>(input.workspace, ...sources.map(s => s.entryId));
        for (const row of rows) {
            const entry = readEntry(db, { workspace: input.workspace, entryId: row.entry_id });
            const artifact = indexArtifact(db, entry);
            if (!artifact)
                continue;
            const fact = { entryId: entry.id, text: entry.body, entities: JSON.parse(row.entities_json), sources: artifact.sources, untrusted: true as const };
            const cost = Array.from(canonicalJson(fact)).length;
            if (cost > remaining) {
                omittedAtomicFacts.push(entry.id);
                continue;
            }
            remaining -= cost;
            atomicFacts.push(fact);
        }
    }
    const atomicSlots = sources.map(source => ({ entryId: source.entryId, remaining: Math.max(0, 8 - liveAtomicCount(db, source)) }));
    return { workId, stage: input.stage, sources, expiresAt, templateVersion: INDEX_TEMPLATE, atomicFacts, omittedAtomicFacts, atomicSlots };
}
function boundWork(db: SqliteDatabase, input: z.infer<typeof indexReviewSchema> | z.infer<typeof indexSubmitSchema>) {
    assertIndexingRunReady(db, input.runId);
    const state = assertAssuranceCwd(db, input.runId, input.cwd);
    if (state.revision !== input.expectedRevision || state.delivery_id !== input.deliveryId)
        conflict('Index assurance or delivery changed');
    const run = new LedgerStore(db).readRun(input.runId);
    if (run?.status !== 'active')
        conflict('Index requires an active completed-intake run');
    const work = db.prepare('SELECT * FROM memory_index_work WHERE work_id=?').get<{
        run_id: string;
        delivery_id: string;
        workspace: string;
        stage: string;
        batch_json: string;
        batch_hash: string;
        template_version: string;
        expires_at: string;
    }>(input.workId);
    if (!work || work.run_id !== input.runId || work.delivery_id !== input.deliveryId || work.workspace !== run.workspace || work.template_version !== INDEX_TEMPLATE || work.expires_at <= new Date().toISOString() || indexMode(db, work.workspace) === 'off')
        conflict('Index batch is expired or unbound');
    const sources = JSON.parse(work.batch_json) as IndexSource[];
    if (canonicalContentHash(sources) !== work.batch_hash)
        conflict('Index batch hash is invalid');
    for (const s of sources) {
        const e = readEntry(db, { workspace: work.workspace, entryId: s.entryId });
        if (!eligible(e) || e.revision !== s.revision || e.contentHash !== s.contentHash)
            conflict('Index source changed');
        const delivered = db.prepare('SELECT 1 AS present FROM context_delivery_entries WHERE delivery_id=? AND entry_id=? AND entry_revision=? AND origin_scope=\'project\'').get(input.deliveryId, s.entryId, s.revision);
        if (!delivered)
            conflict('Index source was not delivered');
    }
    return { work, sources };
}
function replay(db: SqliteDatabase, operationId: string, inputHash: string) {
    const prior = db.prepare('SELECT input_hash,response_json FROM memory_index_operations WHERE operation_id=?').get<{
        input_hash: string;
        response_json: string;
    }>(operationId);
    if (prior) {
        if (prior.input_hash !== inputHash)
            conflict('Index operation identity conflicts');
        return JSON.parse(prior.response_json) as Record<string, unknown>;
    }
    return undefined;
}
function receipt(db: SqliteDatabase, operationId: string, inputHash: string, response: unknown, workId: string) { db.prepare('INSERT INTO memory_index_operations VALUES(?,?,?,?)').run(operationId, workId, inputHash, canonicalJson(response)); }
function liveAtomicCount(db: SqliteDatabase, source: IndexSource): number {
    return db.prepare("SELECT COUNT(*) AS count FROM memory_index_artifacts a JOIN memory_index_sources ms ON ms.artifact_id=a.entry_id JOIN memory_index_work w ON w.work_id=a.work_id JOIN ledger_runs r ON r.run_id=w.run_id WHERE ms.source_id=? AND ms.source_revision=? AND a.knowledge_type='atomic' AND (a.state='supported' OR (a.state='pending' AND w.expires_at>? AND r.status='active'))").get<{
        count: number;
    }>(source.entryId, source.revision, new Date().toISOString())!.count;
}
type IndexUnit = z.infer<typeof indexSubmitSchema>['units'][number];
function validateIndexUnit(db: SqliteDatabase, unit: IndexUnit, stage: string, workId: string, sources: IndexSource[]) {
    if (unit.type !== stage)
        conflict('Wrong indexing stage');
    const expected = unit.type === 'atomic' ? 1 : 2;
    if (unit.sourceIds.length !== expected || new Set(unit.sourceIds).size !== expected)
        conflict('Wrong source count');
    const refs = unit.sourceIds.map(id => {
        const source = sources.find(s => s.entryId === id);
        if (!source)
            conflict('Source outside index batch');
        return source;
    }).sort((a, b) => compareCanonicalStrings(a.entryId, b.entryId));
    const entries = refs.map(s => readEntry(db, { workspace: s.workspace, entryId: s.entryId }));
    for (const s of refs) {
        if (!unit.quotes.some(q => q.entryId === s.entryId))
            conflict('Missing source quote');
    }
    for (const q of unit.quotes) {
        const e = entries.find(e => e.id === q.entryId);
        if (!e || q.end <= q.start || e.body.slice(q.start, q.end) !== q.text)
            conflict('Quote does not match source UTF-16 span');
    }
    if (unit.type === 'atomic') {
        const existing = liveAtomicCount(db, refs[0]!);
        const count = existing + 1;
        if (count > 8)
            conflict('Atomic limit exceeded');
        if (unit.entities.some(e => !unit.quotes.some(q => q.text.includes(e.name))))
            conflict('Entity absent from quote');
    }
    else {
        if (!unit.connection)
            conflict('Bridge requires a complementary connection');
        if (canonicalJson(entries[0]!.scope.applicability ?? null) !== canonicalJson(entries[1]!.scope.applicability ?? null))
            conflict('Applicability differs');
        if (db.prepare("SELECT 1 AS present FROM entry_links WHERE relation='contradicts' AND ((from_entry_id=? AND to_entry_id=?) OR (from_entry_id=? AND to_entry_id=?))").get(refs[0]!.entryId, refs[1]!.entryId, refs[1]!.entryId, refs[0]!.entryId))
            conflict('Contradictory sources');
        const shared = unit.entities.some(entity => refs.every(s => db.prepare("SELECT a.entities_json FROM memory_index_artifacts a JOIN memory_index_sources ms ON ms.artifact_id=a.entry_id WHERE ms.source_id=? AND a.knowledge_type='atomic' AND a.state='supported'").all<{
            entities_json: string;
        }>(s.entryId).some(a => (JSON.parse(a.entities_json) as unknown[]).some(e => canonicalJson(e) === canonicalJson(entity)))));
        if (!shared)
            conflict('No exact qualified shared entity');
    }
    return { refs, entries };
}
function saveIndexUnit(db: SqliteDatabase, unit: IndexUnit, workspace: string, workId: string, binding: ReturnType<typeof validateIndexUnit>) {
    const { refs, entries } = binding;
    const e = recordEntryInTransaction(db, { workspace: workspace, kind: 'fact', status: 'candidate', trustLevel: 'untrusted', confidence: Math.min(.5, ...entries.map(e => e.confidence)), title: unit.title, body: unit.text, scope: { ...entries[0]!.scope, visibility: "project", retrievalScope: "project-only" }, provenance: { type: 'memory_index', reference: workId + ':' + indexMetadataHash(unit.type, refs, unit.entities, unit.quotes, unit.connection ?? null), sourceSetHash: canonicalContentHash(refs), requirementScopeHash: indexMetadataHash(unit.type, refs, unit.entities, unit.quotes, unit.connection ?? null) }, createdBy: 'kiokuko-memory-index' });
    if (db.prepare('SELECT 1 FROM memory_index_artifacts WHERE entry_id=?').get(e.id))
        conflict('Duplicate index candidate');
    db.prepare('INSERT INTO memory_index_artifacts VALUES(?,?,?,?,?,?,?,?,?)').run(e.id, workId, unit.type, e.contentHash, canonicalJson(refs), canonicalJson(unit.entities), canonicalJson(unit.quotes), unit.connection ?? null, 'pending');
    for (const s of refs)
        db.prepare('INSERT INTO memory_index_sources VALUES(?,?,?)').run(e.id, s.entryId, s.revision);
    return { entryId: e.id, revision: e.revision, type: unit.type };
}
export function submitIndex(db: SqliteDatabase, raw: unknown) {
    const input = parseAssurance(indexSubmitSchema, raw);
    if (findSecretInValue(input))
        throw new KiokukoError('SECURITY_REJECTION', 'Index content resembles a secret');
    return withImmediateTransaction(db, () => {
        const { work, sources } = boundWork(db, input), hash = canonicalContentHash(input);
        const old = replay(db, input.operationId, hash);
        if (old)
            return old;
        const saved = [];
        for (const unit of input.units) {
            const binding = validateIndexUnit(db, unit, work.stage, input.workId, sources);
            saved.push(saveIndexUnit(db, unit, work.workspace, input.workId, binding));
        }
        const result = { artifacts: saved, untrusted: true, provenance: 'model_reported' };
        receipt(db, input.operationId, hash, result, input.workId);
        return result;
    });
}
export function reviewIndex(db: SqliteDatabase, raw: unknown) {
    const input = parseAssurance(indexReviewSchema, raw);
    if (findSecretInValue(input))
        throw new KiokukoError('SECURITY_REJECTION', 'Review resembles a secret');
    return withImmediateTransaction(db, () => {
        const { work } = boundWork(db, input), hash = canonicalContentHash(input);
        const old = replay(db, input.operationId, hash);
        if (old)
            return old;
        const e = readEntry(db, { workspace: work.workspace, entryId: input.entryId });
        const a = db.prepare('SELECT * FROM memory_index_artifacts WHERE entry_id=? AND work_id=?').get<{
            state: string;
            sources_json: string;
        }>(e.id, input.workId);
        if (!a || e.revision !== input.entryRevision || a.state !== 'pending')
            conflict('Index artifact changed or already reviewed');
        db.prepare('UPDATE memory_index_artifacts SET state=? WHERE entry_id=?').run('supported', e.id);
        if (!indexArtifact(db, e))
            conflict('Index artifact integrity changed');
        db.prepare('UPDATE memory_index_artifacts SET state=? WHERE entry_id=?').run(input.verdict, e.id);
        if (input.verdict === 'supported')
            for (const s of JSON.parse(a.sources_json) as IndexSource[])
                db.prepare("DELETE FROM memory_index_pending WHERE entry_id=? AND revision=? AND NOT EXISTS(SELECT 1 FROM memory_index_artifacts a JOIN memory_index_sources ms ON ms.artifact_id=a.entry_id JOIN memory_index_work w ON w.work_id=a.work_id JOIN ledger_runs r ON r.run_id=w.run_id WHERE ms.source_id=? AND ms.source_revision=? AND a.state='pending' AND w.expires_at>? AND r.status='active')").run(s.entryId, s.revision, s.entryId, s.revision, new Date().toISOString());
        const result = { entryId: e.id, verdict: input.verdict, untrusted: true, provenance: 'model_reported', basis: input.basis };
        receipt(db, input.operationId, hash, result, input.workId);
        return result;
    });
}
