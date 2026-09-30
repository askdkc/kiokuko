import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { recordEntry, readEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';
import { refreshTaskMemory } from '../../src/assurance/refresh.js';
import { taskAssuranceReport } from '../../src/assurance/service.js';
import { submitIndex, reviewIndex } from '../../src/memory/index-service.js';
import { indexArtifact } from '../../src/memory/index-state.js';
import { searchEntries } from '../../src/memory/retrieval.js';
import { promoteEntry } from '../../src/memory/lifecycle.js';
import { exportWorkspace } from '../../src/commands/export.js';
import { purgeEntry } from '../../src/commands/purge.js';
const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
async function fixture(t: TestContext) { const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-index-')); const cwd = path.join(base, 'repo'); execFileSync('git', ['init', '-q', cwd]); const databasePath = path.join(base, 'db.sqlite3'); await initializeDatabase({ databasePath }); const db = openConnection(databasePath); t.after(async () => { db.close(); await rm(base, { recursive: true, force: true }); }); const project = (await resolveProjectWorkspace(db, cwd))!; db.prepare("INSERT INTO memory_index_settings VALUES(?,'observe')").run(project.workspace); const sources = ['Kiokuko uses SQLite.', 'SQLite uses transactional locking.'].map((body, i) => recordEntry(db, { workspace: project.workspace, kind: 'fact', title: 'source' + i, body, scope: { visibility: 'project', retrievalScope: 'project-only', repositoryId: project.repositoryId } })); const prepared = await prepareAgentTask(db, { cwd, requestId: 'test-index', task: 'Maintain memory index SQLite', capabilities, profileHints: { taskType: 'analysis', target: 'memory index', expected: 'Atomic facts and bridge' }, skillDiscoveryMode: 'off' }); return { db, cwd, project, sources, prepared }; }
async function work(f: Awaited<ReturnType<typeof fixture>>, stage: 'atomic' | 'bridge', requestId: string) { return await refreshTaskMemory(f.db, { cwd: f.cwd, runId: f.prepared.run.runId, requestId, expectedRevision: taskAssuranceReport(f.db, f.prepared.run.runId).revision, capabilities, indexing: { stage } }) as any; }
function input(f: Awaited<ReturnType<typeof fixture>>, w: any, operationId: string) { return { cwd: f.cwd, runId: f.prepared.run.runId, deliveryId: w.context.deliveryId, workId: w.indexing.workId, operationId, expectedRevision: taskAssuranceReport(f.db, f.prepared.run.runId).revision }; }
function unit(e: ReturnType<typeof recordEntry>) { return { type: 'atomic' as const, title: 'atomic', text: e.body, sourceIds: [e.id], entities: [{ kind: 'package' as const, namespace: 'database', name: 'SQLite' }], quotes: [{ entryId: e.id, start: 0, end: e.body.length, text: e.body }] }; }
test('atomic and bridge lifecycle reaches lexical search, preserves trust and rejects stale inputs', async (t) => {
    const f = await fixture(t);
    const w = await work(f, 'atomic', 'atomic-work');
    assert.equal(w.context.items.length, 2);
    for (const e of f.sources) {
        const args = { ...input(f, w, 'submit-' + e.id), units: [unit(e)] };
        const saved = submitIndex(f.db, args) as any;
        assert.deepEqual(submitIndex(f.db, args), saved);
        assert.throws(() => submitIndex(f.db, { ...args, units: [{ ...unit(e), text: 'different' }] }));
        const artifact = readEntry(f.db, { workspace: f.project.workspace, entryId: saved.artifacts[0].entryId });
        assert.equal(artifact.trustLevel, 'untrusted');
        reviewIndex(f.db, { ...input(f, w, 'review-' + e.id), entryId: artifact.id, entryRevision: 1, verdict: 'supported', basis: 'Both source spans entail this atomic statement.' });
        assert.ok(indexArtifact(f.db, artifact));
        assert.throws(() => promoteEntry(f.db, { workspace: f.project.workspace, entryId: artifact.id, expectedRevision: 1 }));
        assert.throws(() => exportWorkspace(f.db, { workspace: f.project.workspace }));
    }
    const b = await work(f, 'bridge', 'bridge-work');
    const bridge = { type: 'bridge' as const, title: 'Kiokuko locking', text: 'Kiokuko uses SQLite transactional locking.', sourceIds: f.sources.map(e => e.id), entities: [{ kind: 'package' as const, namespace: 'database', name: 'SQLite' }], quotes: f.sources.flatMap(e => unit(e).quotes), connection: 'Kiokuko depends on the database whose locking is described in the second source.' };
    const saved = submitIndex(f.db, { ...input(f, b, 'bridge-submit'), units: [bridge] }) as any;
    const id = saved.artifacts[0].entryId;
    reviewIndex(f.db, { ...input(f, b, 'bridge-review'), entryId: id, entryRevision: 1, verdict: 'supported', basis: 'Composition of the two quoted claims.' });
    assert.ok(!searchEntries(f.db, { workspace: f.project.workspace, query: 'Kiokuko locking' }).items.some(e => e.id === id));
    f.db.prepare("UPDATE memory_index_settings SET mode='active' WHERE workspace=?").run(f.project.workspace);
    assert.ok(searchEntries(f.db, { workspace: f.project.workspace, query: 'Kiokuko locking' }).items.some(e => e.id === id));
    const source = f.sources[0]!;
    updateCandidateEntry(f.db, { workspace: source.workspace, entryId: source.id, expectedRevision: 1, kind: 'fact', title: source.title, body: 'Kiokuko now uses another database.', scope: source.scope });
    assert.equal(indexArtifact(f.db, readEntry(f.db, { workspace: source.workspace, entryId: id })), undefined);
    assert.throws(() => submitIndex(f.db, { ...input(f, b, 'late-submit'), units: [bridge] }));
    assert.ok(f.db.prepare('SELECT 1 FROM memory_index_pending WHERE entry_id=?').get(source.id));
});
test('false UTF-16 quotations and foreign source IDs roll back without artifacts', async (t) => {
    const f = await fixture(t);
    const w = await work(f, 'atomic', 'quotes-work');
    const e = f.sources[0]!;
    assert.throws(() => submitIndex(f.db, { ...input(f, w, 'false-quote'), units: [{ ...unit(e), quotes: [{ entryId: e.id, start: 1, end: e.body.length, text: e.body }] }] }));
    assert.throws(() => submitIndex(f.db, { ...input(f, w, 'foreign-source'), units: [{ ...unit(e), sourceIds: ['foreign'] }] }));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM memory_index_artifacts').get<{
        count: number;
    }>()!.count, 0);
});
async function atomic(f: Awaited<ReturnType<typeof fixture>>) {
    const w = await work(f, 'atomic', 'atomic');
    const artifacts = f.sources.map(e => { const result = submitIndex(f.db, { ...input(f, w, 'submit-' + e.id), units: [unit(e)] }) as any; const id = result.artifacts[0].entryId; reviewIndex(f.db, { ...input(f, w, 'review-' + e.id), entryId: id, entryRevision: 1, verdict: 'supported', basis: 'Quoted source entails the assertion.' }); return readEntry(f.db, { workspace: f.project.workspace, entryId: id }); });
    return { w, artifacts };
}
test('purge removes managed bodies, search projections, operation receipts and late work', async (t) => {
    const f = await fixture(t);
    const { w, artifacts } = await atomic(f);
    const source = f.sources[0]!;
    purgeEntry(f.db, { workspace: source.workspace, entryId: source.id, confirm: true });
    for (const a of artifacts)
        assert.throws(() => readEntry(f.db, { workspace: a.workspace, entryId: a.id }));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_index_work').get<{
        n: number;
    }>()!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_index_operations').get<{
        n: number;
    }>()!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_index_artifacts').get<{
        n: number;
    }>()!.n, 0);
    assert.throws(() => submitIndex(f.db, { ...input(f, w, 'after-purge'), units: [unit(source)] }));
    assert.deepEqual(f.db.prepare('PRAGMA foreign_key_check').all(), []);
});
test('unsupported, expired, separate delivery and managed editing fail closed', async (t) => {
    const f = await fixture(t);
    const w = await work(f, 'atomic', 'atomic');
    const e = f.sources[0]!;
    const saved = submitIndex(f.db, { ...input(f, w, 'one'), units: [unit(e)] }) as any;
    const a = readEntry(f.db, { workspace: e.workspace, entryId: saved.artifacts[0].entryId });
    reviewIndex(f.db, { ...input(f, w, 'unsupported'), entryId: a.id, entryRevision: 1, verdict: 'unsupported', basis: 'This assertion is not established.' });
    assert.equal(indexArtifact(f.db, a), undefined);
    assert.throws(() => updateCandidateEntry(f.db, { workspace: a.workspace, entryId: a.id, expectedRevision: 1, kind: 'fact', title: 'edit', body: 'edit', scope: a.scope }));
    assert.throws(() => submitIndex(f.db, { ...input(f, w, 'different-delivery'), deliveryId: 'different', units: [unit(e)] }));
    f.db.prepare("UPDATE memory_index_work SET expires_at='2000-01-01T00:00:00.000Z' WHERE work_id=?").run(w.indexing.workId);
    assert.throws(() => submitIndex(f.db, { ...input(f, w, 'expired'), units: [unit(e)] }));
});
test('off and observe preserve ordinary content; active quotes and generated budgets reach final context', async (t) => {
    const { queryScopedContext } = await import('../../src/context/scoped-broker.js');
    const f = await fixture(t);
    await atomic(f);
    await makeBridge(f);
    const query = { project: f.project, task: 'Kiokuko SQLite transactional locking', taskProfile: { taskType: 'analysis' as const, target: 'Kiokuko SQLite transactional locking', expected: 'Answer from memory', constraints: null }, characterBudget: 8000 };
    f.db.prepare("UPDATE memory_index_settings SET mode='off'").run();
    const off = await queryScopedContext(f.db, query);
    f.db.prepare("UPDATE memory_index_settings SET mode='observe'").run();
    const observe = await queryScopedContext(f.db, query);
    assert.deepEqual(observe.items, off.items);
    assert.ok(observe.memoryIndexDiagnostics!.generated.length > 0);
    f.db.prepare("UPDATE memory_index_settings SET mode='active'").run();
    const active = await queryScopedContext(f.db, query);
    const generated = active.items.filter(i => i.knowledgeType);
    assert.ok(generated.length > 0);
    assert.ok(generated.every(i => i.bodyPreview.includes('Quotes:') && (i.sources?.length === 1 || i.sources?.length === 2)));
    const cost = (i: typeof active.items[number]) => Array.from(i.title + (i.summary ?? '') + i.bodyPreview).length;
    assert.ok(generated.reduce((n, i) => n + cost(i), 0) <= 4000);
    assert.ok(active.items.reduce((n, i) => n + cost(i), 0) <= 8000);
    assert.equal(new Set(active.items.map(i => i.knowledgeType === 'atomic' ? i.sources![0]!.entryId : i.entryId)).size, active.items.length);
    const tiny = await queryScopedContext(f.db, { ...query, characterBudget: 500 });
    assert.ok(tiny.items.filter(i => i.knowledgeType).reduce((n, i) => n + cost(i), 0) <= 250);
});
test('corrupted managed projection is excluded while original search continues', async (t) => {
    const f = await fixture(t);
    const { artifacts } = await atomic(f);
    f.db.prepare("UPDATE memory_index_settings SET mode='active'").run();
    const a = artifacts[0]!;
    f.db.prepare("UPDATE memory_index_artifacts SET quotes_json='invalid' WHERE entry_id=?").run(a.id);
    const hits = searchEntries(f.db, { workspace: a.workspace, query: 'Kiokuko SQLite' }).items;
    assert.ok(!hits.some(e => e.id === a.id));
    assert.ok(hits.some(e => e.id === f.sources[0]!.id));
});
test('atomic quota is cumulative across submissions and generated entries never enter source batches', async (t) => {
    const f = await fixture(t);
    const w = await work(f, 'atomic', 'quota');
    const e = f.sources[0]!;
    for (let i = 0; i < 8; i++)
        submitIndex(f.db, { ...input(f, w, 'unit' + i), units: [{ ...unit(e), title: 'unit' + i }] });
    assert.throws(() => submitIndex(f.db, { ...input(f, w, 'ninth'), units: [{ ...unit(e), title: 'ninth' }] }));
    const { indexingSources } = await import('../../src/memory/index-service.js');
    assert.ok(indexingSources(f.db, e.workspace, 'atomic').every(s => s.createdBy !== 'kiokuko-memory-index'));
});
test('whole-source maintenance reports over-budget sources without slicing', async (t) => {
    const f = await fixture(t);
    const e = f.sources[0]!;
    updateCandidateEntry(f.db, { workspace: e.workspace, entryId: e.id, expectedRevision: 1, kind: 'fact', title: e.title, body: 'SQLite '.repeat(2000), scope: e.scope });
    const w = await work(f, 'atomic', 'oversized');
    assert.ok(w.indexing.unprocessed.some((p: any) => p.entryId === e.id));
    assert.ok(!w.indexing.sources.some((s: any) => s.entryId === e.id));
});
test('SQLite backup preserves bound work and supported artifacts', async (t) => {
    const { createBackup } = await import('../../src/commands/backup.js');
    const f = await fixture(t);
    const { artifacts } = await atomic(f);
    const destination = path.join(path.dirname(f.db.filePath), 'backup.sqlite3');
    await createBackup(destination, f.db.filePath);
    const restored = openConnection(destination);
    try {
        assert.ok(indexArtifact(restored, readEntry(restored, { workspace: f.project.workspace, entryId: artifacts[0]!.id })));
        assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
    }
    finally {
        restored.close();
    }
});
test('managed vectors are gated before top-k and reject late invalidated completion', async (t) => {
    const { parseEmbeddingConfig, requireEnabledEmbeddingConfig } = await import('../../src/embedding/config.js');
    const { createEmbeddingProfile } = await import('../../src/embedding/profile.js');
    const { activateEmbeddingProfile, upsertEntryEmbedding } = await import('../../src/embedding/store.js');
    const { JavaScriptVectorSearchBackend } = await import('../../src/embedding/javascript-backend.js');
    const { hybridSearch } = await import('../../src/memory/hybrid-retrieval.js');
    const f = await fixture(t);
    const { artifacts } = await atomic(f);
    const profile = createEmbeddingProfile(requireEnabledEmbeddingConfig(parseEmbeddingConfig({ KIOKUKO_EMBEDDINGS: 'optional', KIOKUKO_EMBEDDING_BASE_URL: 'http://127.0.0.1:8080/v1', KIOKUKO_EMBEDDING_MODEL: 'index-test', KIOKUKO_EMBEDDING_DIMENSIONS: '3', KIOKUKO_EMBEDDING_DISTANCE_CEILING: '0.8' })));
    activateEmbeddingProfile(f.db, profile, { replace: false });
    const a = artifacts[0]!;
    const vectorInput = { entryId: a.id, profileId: profile.profileId, revision: a.revision, contentHash: a.contentHash, documentHash: 'a'.repeat(64), vector: [1, 0, 0], createdAt: new Date().toISOString() };
    upsertEntryEmbedding(f.db, vectorInput);
    const backend = new JavaScriptVectorSearchBackend();
    const runtime = { semantic: { query: { profileId: profile.profileId, dimensions: 3, vector: new Float32Array([1, 0, 0]), vectorHash: 'b'.repeat(64), backendId: backend.id, distanceCeiling: .8 }, backend } };
    assert.equal(hybridSearch(f.db, { workspace: a.workspace, query: 'unrelated', limit: 10 }, runtime).length, 0);
    f.db.prepare("UPDATE memory_index_settings SET mode='active'").run();
    assert.ok(hybridSearch(f.db, { workspace: a.workspace, query: 'unrelated', limit: 10 }, runtime).some(h => h.entryId === a.id));
    const { createSqliteVecLoader } = await import('../../src/embedding/sqlite-vec-loader.js');
    const loader = await createSqliteVecLoader();
    if (loader) {
        const { SqliteVecVectorSearchBackend } = await import('../../src/embedding/sqlite-vec-backend.js');
        const native = openConnection(f.db.filePath, { sqliteVecLoader: loader });
        try {
            const nativeBackend = new SqliteVecVectorSearchBackend();
            const nativeRuntime = { semantic: { query: { ...runtime.semantic.query, backendId: nativeBackend.id }, backend: nativeBackend } };
            assert.ok(hybridSearch(native, { workspace: a.workspace, query: 'unrelated', limit: 10 }, nativeRuntime).some(h => h.entryId === a.id));
            const raw = f.sources[1]!;
            upsertEntryEmbedding(f.db, { ...vectorInput, entryId: raw.id, revision: raw.revision, contentHash: raw.contentHash });
            const broken = new Float32Array([NaN, 0, 0]);
            f.db.prepare('UPDATE entry_embeddings SET embedding=?,vector_hash=? WHERE entry_id=?').run(Buffer.from(broken.buffer), 'c'.repeat(64), a.id);
            const surviving = hybridSearch(native, { workspace: a.workspace, query: 'unrelated', limit: 10 }, nativeRuntime);
            assert.ok(surviving.some(h => h.entryId === raw.id));
            assert.ok(!surviving.some(h => h.entryId === a.id));
        }
        finally {
            native.close();
        }
    }
    else {
        t.diagnostic('Native artifact lane unavailable; mandatory package smoke checks this independently.');
    }
    const source = f.sources[0]!;
    updateCandidateEntry(f.db, { workspace: source.workspace, entryId: source.id, expectedRevision: 1, kind: 'fact', title: source.title, body: 'Kiokuko uses something else', scope: source.scope });
    assert.throws(() => upsertEntryEmbedding(f.db, vectorInput));
    assert.ok(!hybridSearch(f.db, { workspace: a.workspace, query: 'unrelated', limit: 10 }, runtime).some(h => h.entryId === a.id));
});
async function makeBridge(f: Awaited<ReturnType<typeof fixture>>, text = 'Kiokuko uses SQLite transactional locking.', title = 'Kiokuko locking') {
    const b = await work(f, 'bridge', 'bridge');
    const bridge = { type: 'bridge' as const, title, text, sourceIds: f.sources.map(e => e.id), entities: [{ kind: 'package' as const, namespace: 'database', name: 'SQLite' }], quotes: f.sources.flatMap(e => unit(e).quotes), connection: 'The first source depends on the entity whose behavior the second source describes.' };
    const saved = submitIndex(f.db, { ...input(f, b, 'bridge-submit'), units: [bridge] }) as any;
    const id = saved.artifacts[0].entryId;
    reviewIndex(f.db, { ...input(f, b, 'bridge-review'), entryId: id, entryRevision: 1, verdict: 'supported', basis: 'Both exact source claims establish the composition under matching applicability.' });
    return id;
}
test('fixed bilingual index evaluation compares four variants with identical context budgets', async (t) => {
    const { readFile } = await import('node:fs/promises');
    const { queryScopedContext } = await import('../../src/context/scoped-broker.js');
    const cases = JSON.parse(await readFile(new URL('../fixtures/memory-index/evaluation.json', import.meta.url), 'utf8')) as {
        id: string;
        topic: string;
        sources: string[];
        query: string;
        bridge: string;
        expected: string;
        sourceCount: number;
    }[];
    for (const c of cases) {
        const f = await fixture(t);
        f.sources = f.sources.map((e, i) => e.body === c.sources[i] ? e : updateCandidateEntry(f.db, { workspace: e.workspace, entryId: e.id, expectedRevision: 1, kind: 'fact', title: 'source' + i, body: c.sources[i]!, scope: e.scope }));
        const { artifacts } = await atomic(f);
        const bridgeId = await makeBridge(f, c.bridge, c.query);
        // The answer key is scoring data, never a retrieval/ranking input.
        const profile = { taskType: 'analysis' as const, target: c.query, expected: 'Answer the question using only the supplied memory evidence.', constraints: null };
        const rows = [];
        for (const variant of ['current', 'atomic', 'atomic+bridge', 'bridge-hint-only']) {
            f.db.prepare('UPDATE memory_index_settings SET mode=?').run(variant === 'current' ? 'off' : 'active');
            f.db.prepare('UPDATE memory_index_artifacts SET state=? WHERE entry_id=?').run(variant === 'atomic' ? 'uncertain' : 'supported', bridgeId);
            const start = performance.now();
            const result = await queryScopedContext(f.db, { project: f.project, task: c.query, taskProfile: profile, characterBudget: 8000 });
            const elapsedMs = performance.now() - start;
            const items = variant === 'bridge-hint-only' ? result.items.filter(i => i.knowledgeType !== 'bridge') : result.items;
            const ids = items.flatMap(i => i.sources?.map(s => s.entryId) ?? [i.entryId]);
            const expected = f.sources.slice(0, c.sourceCount).map(e => e.id);
            const covered = expected.filter(id => ids.includes(id));
            const ranks = expected.map(id => items.findIndex(i => i.entryId === id || i.sources?.some(s => s.entryId === id))).map(rank => rank < 0 ? 0 : 1 / (rank + 1));
            assert.ok(items.reduce((sum, i) => sum + Array.from(i.title + (i.summary ?? '') + i.bodyPreview).length, 0) <= 8000);
            if (variant === 'current')
                assert.ok(items.every(i => !i.knowledgeType));
            if (variant === 'atomic')
                assert.ok(items.every(i => i.knowledgeType !== 'bridge'));
            if (variant === 'atomic+bridge') {
                assert.ok(items.some(i => i.knowledgeType === 'bridge'));
                assert.equal(covered.length, expected.length);
            }
            if (variant === 'bridge-hint-only')
                assert.ok(items.every(i => i.knowledgeType !== 'bridge'));
            rows.push({ variant, recall: covered.length / expected.length, mrr: ranks.reduce((a, b) => a + b, 0) / ranks.length, evidenceCoverage: covered.length, elapsedMs, context: items.map(i => ({ body: i.bodyPreview, sources: i.sources ?? [{ entryId: i.entryId }] })), answerAccuracy: null, unsupportedAssertions: null });
        }
        const bytes = f.db.prepare('SELECT SUM(length(body)) AS bytes FROM entry_revisions').get<{
            bytes: number;
        }>()!.bytes;
        t.diagnostic(JSON.stringify({ case: c.id, topic: c.topic, expected: c.expected, contextBudget: 8000, generatedCount: artifacts.length + 1, storedTextCharacters: bytes, databaseBytes: Number(f.db.prepare('PRAGMA page_count').get()!.page_count) * Number(f.db.prepare('PRAGMA page_size').get()!.page_size), variants: rows }));
    }
});
test('bridge rejects known contradiction links', async (t) => {
    const { linkEntries } = await import('../../src/memory/lifecycle.js');
    const f = await fixture(t);
    await atomic(f);
    linkEntries(f.db, { workspace: f.project.workspace, fromEntryId: f.sources[0]!.id, toEntryId: f.sources[1]!.id, relation: 'contradicts' });
    await assert.rejects(() => makeBridge(f), /Contradictory sources/);
});
test('supersede invalidates every dependent output', async (t) => {
    const { supersedeEntry } = await import('../../src/memory/lifecycle.js');
    const f = await fixture(t);
    const { artifacts } = await atomic(f);
    const replacement = recordEntry(f.db, { workspace: f.project.workspace, kind: 'fact', title: 'replacement', body: 'Kiokuko uses PostgreSQL.' });
    supersedeEntry(f.db, { workspace: f.project.workspace, oldEntryId: f.sources[0]!.id, replacementEntryId: replacement.id, expectedRevision: 1 });
    assert.equal(indexArtifact(f.db, artifacts[0]!), undefined);
});
test('HTTP index routes bind run and operation to path and header, sharing replay', async (t) => {
    const { createTaskAssuranceRoute } = await import('../../src/server/routes/task-assurance.js');
    const f = await fixture(t);
    const w = await work(f, 'atomic', 'transport');
    const route = createTaskAssuranceRoute({ database: f.db, enqueueWrite: async (operation) => await operation() });
    const { runId, operationId, ...body } = input(f, w, 'http-submit');
    const request = { method: 'POST', url: new URL(`http://localhost/api/v1/agent/runs/${runId}/memory-index-submit`), headers: { 'idempotency-key': operationId }, body: { ...body, units: [unit(f.sources[0]!)] } };
    const result = await route(request);
    assert.deepEqual(await route(request), result);
    assert.equal((result as any).ok, true);
    await assert.rejects(async () => route({ ...request, body: { ...request.body, operationId } }));
    await assert.rejects(async () => route({ ...request, body: { ...request.body, runId } }));
});
test('active delivery replay keeps citations exactly once and mode changes invalidate it', async (t) => {
    const { queryScopedContext } = await import('../../src/context/scoped-broker.js');
    const f = await fixture(t);
    await atomic(f);
    await makeBridge(f);
    f.db.prepare("UPDATE memory_index_settings SET mode='active'").run();
    const query = { project: f.project, task: 'Maintain memory index SQLite', taskProfile: f.prepared.intake.profile, runId: f.prepared.run.runId, characterBudget: 8000 };
    const first = await queryScopedContext(f.db, query);
    const again = await queryScopedContext(f.db, query);
    assert.ok(first.deliveryId);
    assert.equal(again.deliveryId, first.deliveryId);
    assert.deepEqual(again.items, first.items);
    assert.ok(first.items.some(i => i.knowledgeType === 'bridge'));
    for (const i of first.items.filter(i => i.knowledgeType))
        assert.equal(i.bodyPreview.split('\nQuotes:').length, 2);
    f.db.prepare("UPDATE memory_index_settings SET mode='off'").run();
    const off = await queryScopedContext(f.db, query);
    assert.notEqual(off.deliveryId, first.deliveryId);
    assert.ok(off.items.every(i => !i.knowledgeType));
});
test('bridge count and character ceilings preserve original and preference context', async (t) => {
    const { queryScopedContext } = await import('../../src/context/scoped-broker.js');
    const f = await fixture(t);
    await atomic(f);
    const w = await work(f, 'bridge', 'many-bridges');
    const units = Array.from({ length: 5 }, (_, i) => ({ type: 'bridge' as const, title: 'SQLite locking ' + i, text: 'Kiokuko uses SQLite transactional locking.', sourceIds: f.sources.map(e => e.id), entities: [{ kind: 'package' as const, namespace: 'database', name: 'SQLite' }], quotes: f.sources.flatMap(e => unit(e).quotes), connection: 'The application uses the engine described by the second source.' }));
    const saved = submitIndex(f.db, { ...input(f, w, 'many'), units }) as any;
    for (const a of saved.artifacts)
        reviewIndex(f.db, { ...input(f, w, 'review-' + a.entryId), entryId: a.entryId, entryRevision: 1, verdict: 'supported', basis: 'The two source statements compose.' });
    const pref = recordEntry(f.db, { workspace: f.project.workspace, kind: 'preference', title: 'SQLite preference', body: 'Use existing local configuration.' });
    f.db.prepare("UPDATE memory_index_settings SET mode='active'").run();
    const budget = 8000;
    const result = await queryScopedContext(f.db, { project: f.project, task: 'SQLite locking', taskProfile: { taskType: 'analysis', target: 'SQLite locking', expected: 'Answer', constraints: null }, characterBudget: budget, limit: 100 });
    const bridges = result.items.filter(i => i.knowledgeType === 'bridge');
    assert.ok(bridges.length > 0 && bridges.length <= 3);
    const cost = (i: typeof result.items[number]) => Array.from(i.title + (i.summary ?? '') + i.bodyPreview).length;
    assert.ok(bridges.reduce((n, i) => n + cost(i), 0) <= budget * .3);
    assert.ok(result.items.filter(i => i.knowledgeType).reduce((n, i) => n + cost(i), 0) <= budget * .5);
    assert.ok(result.items.some(i => i.entryId === pref.id));
    assert.ok(result.items.some(i => f.sources.some(s => s.id === i.entryId)));
});
test('incomplete intake, wrong repository and stale assurance cannot maintain memory', async (t) => {
    const f = await fixture(t);
    const w = await work(f, 'atomic', 'gate');
    assert.throws(() => submitIndex(f.db, { ...input(f, w, 'stale-assurance'), expectedRevision: 1, units: [unit(f.sources[0]!)] }));
    assert.throws(() => submitIndex(f.db, { ...input(f, w, 'wrong-repository'), cwd: path.dirname(f.cwd), units: [unit(f.sources[0]!)] }));
    const args = { ...input(f, w, 'unfinished-submit'), units: [unit(f.sources[0]!)] };
    f.db.prepare('UPDATE run_intakes SET finalized_at=NULL WHERE run_id=?').run(f.prepared.run.runId);
    await assert.rejects(() => refreshTaskMemory(f.db, { cwd: f.cwd, runId: args.runId, requestId: 'unfinished', expectedRevision: args.expectedRevision, capabilities, indexing: { stage: 'atomic' } }), /intake/);
    assert.throws(() => submitIndex(f.db, args), /completed intake/);
});
test('partial valid submissions roll back entirely when another quote is invalid', async (t) => {
    const f = await fixture(t);
    const w = await work(f, 'atomic', 'rollback');
    const a = f.sources[0]!, b = f.sources[1]!;
    assert.throws(() => submitIndex(f.db, { ...input(f, w, 'rollback-submit'), units: [unit(a), { ...unit(b), quotes: [{ entryId: b.id, start: 1, end: b.body.length, text: b.body }] }] }));
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_index_artifacts').get<{
        n: number;
    }>()!.n, 0);
    assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM entries WHERE created_by='kiokuko-memory-index'").get<{
        n: number;
    }>()!.n, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM memory_index_operations').get<{
        n: number;
    }>()!.n, 0);
});
test('bridging rejects unequal applicability and later contradiction invalidates output', async (t) => {
    const { linkEntries } = await import('../../src/memory/lifecycle.js');
    const f = await fixture(t);
    await atomic(f);
    const id = await makeBridge(f);
    linkEntries(f.db, { workspace: f.project.workspace, fromEntryId: f.sources[0]!.id, toEntryId: f.sources[1]!.id, relation: 'contradicts' });
    assert.equal(indexArtifact(f.db, readEntry(f.db, { workspace: f.project.workspace, entryId: id })), undefined);
    const g = await fixture(t);
    await atomic(g);
    const old = g.sources[1]!;
    const updated = updateCandidateEntry(g.db, { workspace: old.workspace, entryId: old.id, expectedRevision: 1, kind: 'fact', title: old.title, body: old.body, scope: { ...old.scope, applicability: { tools: ['different-environment'] } } });
    g.sources[1] = updated;
    const w = await work(g, 'atomic', 'new-applicability');
    const saved = submitIndex(g.db, { ...input(g, w, 'changed-atomic'), units: [unit(updated)] }) as any;
    reviewIndex(g.db, { ...input(g, w, 'changed-review'), entryId: saved.artifacts[0].entryId, entryRevision: 1, verdict: 'supported', basis: 'The exact claim is preserved within its new applicability.' });
    await assert.rejects(() => makeBridge(g), /Applicability differs/);
});
test('JSONL v2 cannot import managed knowledge even with valid checksum and content hash', async (t) => {
    const { writeFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { importWorkspace } = await import('../../src/commands/import.js');
    const { canonicalJson, canonicalEntryRevisionContentHash } = await import('../../src/serialization/validate.js');
    const f = await fixture(t);
    const archive = exportWorkspace(f.db, { workspace: f.project.workspace });
    const lines = archive.content.trimEnd().split('\n').slice(1).map(line => JSON.parse(line));
    const e = lines.find(line => line.type === 'entry');
    e.created_by = 'kiokuko-memory-index';
    e.provenance_json = canonicalJson({ type: 'memory_index', reference: 'archived-index' });
    e.content_hash = canonicalEntryRevisionContentHash({ kind: e.kind, title: e.title, body: e.body, summary: e.summary, scope: JSON.parse(e.scope_json), provenance: JSON.parse(e.provenance_json), tags: [] });
    const payload = lines.map(line => canonicalJson(line)).join('\n') + '\n';
    const checksum = createHash('sha256').update(payload).digest('hex');
    const file = path.join(path.dirname(f.db.filePath), 'managed.jsonl');
    await writeFile(file, canonicalJson({ type: 'checksum', sha256: checksum }) + '\n' + payload);
    await assert.rejects(() => importWorkspace(f.db, { input: file, dryRun: true }), /memory index metadata/);
});
test('parallel work shares per-source quota and expired unreviewed work can resume', async (t) => {
    const f = await fixture(t);
    const w = await work(f, 'atomic', 'first-batch');
    const source = f.sources[0]!;
    submitIndex(f.db, { ...input(f, w, 'eight'), units: Array.from({ length: 8 }, (_, i) => ({ ...unit(source), title: 'fact' + i })) });
    f.prepared = await prepareAgentTask(f.db, { cwd: f.cwd, requestId: 'separate-root', task: 'Maintain memory index SQLite', capabilities, profileHints: { taskType: 'analysis', target: 'memory index', expected: 'Atomic facts and bridge' }, skillDiscoveryMode: 'off' });
    const next = await work(f, 'atomic', 'second-batch');
    const args = { ...input(f, next, 'resumed'), units: [{ ...unit(source), title: 'resumed fact' }] };
    assert.throws(() => submitIndex(f.db, args), /Atomic limit/);
    f.db.prepare("UPDATE memory_index_work SET expires_at='2000-01-01T00:00:00.000Z' WHERE work_id=?").run(w.indexing.workId);
    assert.ok((submitIndex(f.db, args) as any).artifacts.length === 1);
});
test('partially reviewed expired work resumes without leaving a stuck source queue', async (t) => {
    const f = await fixture(t);
    const w = await work(f, 'atomic', 'partial');
    const source = f.sources[0]!;
    const saved = submitIndex(f.db, { ...input(f, w, 'three'), units: Array.from({ length: 3 }, (_, i) => ({ ...unit(source), title: 'partial ' + i })) }) as any;
    reviewIndex(f.db, { ...input(f, w, 'first-review'), entryId: saved.artifacts[0].entryId, entryRevision: 1, verdict: 'supported', basis: 'This claim follows from the exact source.' });
    f.db.prepare("UPDATE memory_index_work SET expires_at='2000-01-01T00:00:00.000Z' WHERE work_id=?").run(w.indexing.workId);
    f.prepared = await prepareAgentTask(f.db, { cwd: f.cwd, requestId: 'partial-resume-root', task: 'Maintain memory index SQLite', capabilities, profileHints: { taskType: 'analysis', target: 'memory index', expected: 'Atomic facts and bridge' }, skillDiscoveryMode: 'off' });
    const next = await work(f, 'atomic', 'partial-resume');
    assert.ok(next.indexing.atomicFacts.some((e: any) => e.entryId === saved.artifacts[0].entryId));
    assert.equal(next.indexing.atomicSlots.find((e: any) => e.entryId === source.id).remaining, 7);
    const added = submitIndex(f.db, { ...input(f, next, 'remaining'), units: [{ ...unit(source), title: 'Completed fact' }] }) as any;
    reviewIndex(f.db, { ...input(f, next, 'remaining-review'), entryId: added.artifacts[0].entryId, entryRevision: 1, verdict: 'supported', basis: 'The current source supports the complete statement.' });
    assert.equal(f.db.prepare('SELECT 1 FROM memory_index_pending WHERE entry_id=?').get(source.id), undefined);
});
test('MCP submit and review transport reaches the same bound candidate storage', async (t) => {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { createKiokukoMcpServer } = await import('../../src/mcp/server.js');
    const f = await fixture(t);
    const w = await work(f, 'atomic', 'mcp');
    const server = createKiokukoMcpServer({ databasePath: f.db.filePath, cwd: () => f.cwd });
    const client = new Client({ name: 'index-test', version: '1.0.0' });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    await client.connect(c);
    try {
        const result = await client.callTool({ name: 'memory_index_submit', arguments: { ...input(f, w, 'mcp-submit'), units: [unit(f.sources[0]!)] } });
        assert.ok(!result.isError);
        const saved = JSON.parse((result.content as any)[0].text);
        const review = await client.callTool({ name: 'memory_index_review', arguments: { ...input(f, w, 'mcp-review'), entryId: saved.artifacts[0].entryId, entryRevision: 1, verdict: 'supported', basis: 'This claim is supported by the full quoted source.' } });
        assert.ok(!review.isError);
        const entry = readEntry(f.db, { workspace: f.project.workspace, entryId: saved.artifacts[0].entryId });
        assert.ok(indexArtifact(f.db, entry));
        assert.equal(entry.trustLevel, 'untrusted');
    }
    finally {
        await client.close();
        await server.close();
    }
});
test('CLI status, mode and rebuild dry-run operate only on the bound project', async (t) => {
    const { Command } = await import('commander');
    const { registerMemoryIndexCommands } = await import('../../src/commands/memory-index.js');
    const f = await fixture(t);
    const { artifacts } = await atomic(f);
    const run = async (args: string[]) => { const command = new Command(); registerMemoryIndexCommands(command, { withDatabase: async (fn) => await fn(f.db) }); let text = ''; const original = process.stdout.write; process.stdout.write = ((chunk: string | Uint8Array) => { text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'); return true; }) as typeof process.stdout.write; try {
        await command.parseAsync(['node', 'kiokuko', 'memory-index', ...args, '--cwd', f.cwd]);
        return JSON.parse(text);
    }
    finally {
        process.stdout.write = original;
    } };
    f.db.prepare('DELETE FROM memory_index_settings WHERE workspace=?').run(f.project.workspace);
    assert.equal((await run(['status'])).mode, 'off');
    assert.equal((await run(['mode', 'observe'])).mode, 'observe');
    assert.equal((await run(['rebuild', '--dry-run'])).dryRun, true);
    assert.ok(indexArtifact(f.db, artifacts[0]!));
    await run(['rebuild']);
    assert.equal(indexArtifact(f.db, artifacts[0]!), undefined);
    assert.equal((await run(['status'])).pending.count, 2);
    await assert.rejects(() => run(['mode', 'unknown']));
    assert.equal((await run(['status'])).mode, 'observe');
});
