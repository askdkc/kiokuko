import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { openConnection } from '../../src/db/connection.js';
import { loadMigrationSnapshot, migrateDatabase } from '../../src/db/migrate.js';
import { useRepository } from '../../src/commands/use.js';
import { recordEntry, readEntry } from '../../src/memory/entries.js';
import { supersedeEntry } from '../../src/memory/lifecycle.js';
import { recallEntries } from '../../src/memory/retrieval.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { recordCodeVersion, readCodeVersions } from '../../src/memory/code-versions.js';
import { currentMemoryApplicability, evaluateMemoryApplicability, assertMemoryApplicabilityUnchanged } from '../../src/memory/applicability-context.js';
import { finalizeHistoryRecall } from '../../src/memory/history-delivery.js';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { retrievableWorkspaceEntryCount } from '../../src/memory/hybrid-retrieval.js';
async function fixture(t: TestContext) {
    const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-history-'));
    const projectRoot = path.join(root, 'project');
    execFileSync('git', ['init', '-q', '-b', 'main', projectRoot]);
    const databasePath = path.join(root, 'memory.sqlite3');
    const db = openConnection(databasePath);
    migrateDatabase(db);
    const project = await useRepository({ root: projectRoot, databasePath, allowDirectory: true });
    t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
    return { root, db, databasePath, project };
}
test('active related recall follows A to B to C without resurrecting ancestors after restart', async (t) => {
    const f = await fixture(t), workspace = f.project.workspace;
    const a = recordEntry(f.db, { workspace, kind: 'fact', title: 'oldmarkera socket strategy', body: 'Outdated first version.' });
    const b = recordEntry(f.db, { workspace, kind: 'fact', title: 'middle implementation', body: 'Superseded second version.' });
    const c = recordEntry(f.db, { workspace, kind: 'fact', title: 'current implementation', body: 'Current final version.' });
    supersedeEntry(f.db, { workspace, oldEntryId: a.id, replacementEntryId: b.id, expectedRevision: 1 });
    supersedeEntry(f.db, { workspace, oldEntryId: b.id, replacementEntryId: c.id, expectedRevision: 1 });
    const restarted = openConnection(f.databasePath);
    try {
        const result = recallEntries(restarted, { workspace, query: 'oldmarkera', relatedMode: 'active' });
        assert.deepEqual(result.items.map(x => x.id), [c.id]);
        assert.equal(readEntry(restarted, { workspace, entryId: a.id }).supersededBy, b.id);
    }
    finally {
        restarted.close();
    }
});
test('identical supersession replay is idempotent while a different successor conflicts', async (t) => {
    const f = await fixture(t), workspace = f.project.workspace;
    const a = recordEntry(f.db, { workspace, kind: 'fact', title: 'before', body: 'before' }), b = recordEntry(f.db, { workspace, kind: 'fact', title: 'after', body: 'after' }), c = recordEntry(f.db, { workspace, kind: 'fact', title: 'alternative', body: 'alternative' });
    const input = { workspace, oldEntryId: a.id, replacementEntryId: b.id, expectedRevision: 1 };
    supersedeEntry(f.db, input);
    const before = f.db.prepare('SELECT COUNT(*) count FROM audit_events').get();
    assert.equal(supersedeEntry(f.db, input).supersededBy, b.id);
    assert.deepEqual(f.db.prepare('SELECT COUNT(*) count FROM audit_events').get(), before);
    assert.throws(() => supersedeEntry(f.db, { ...input, replacementEntryId: c.id }), { code: 'CONFLICT' });
});
test('explicit final output bound counts the full serialized recall including repeated summary metadata', async (t) => {
    const f = await fixture(t), workspace = f.project.workspace;
    recordEntry(f.db, { workspace, kind: 'reference', title: 'budgetmarker', body: 'x'.repeat(18000), summary: '😀'.repeat(18000) });
    const input = { workspace, query: 'budgetmarker', maxChars: 14000, maxOutputChars: 14000, includeHistory: true };
    const result = recallEntries(f.db, input);
    assert.ok(Array.from(JSON.stringify(result)).length <= 14000);
});
test('branch-constrained recall cannot fall back from a different branch', async (t) => {
    const f = await fixture(t), workspace = f.project.workspace;
    const scope = buildStructuredScope({ visibility: 'project', repositoryId: f.project.repositoryId, applicability: { branches: ['other-branch'] } as never });
    recordEntry(f.db, { workspace, kind: 'fact', title: 'branchmarker', body: 'Only for a different branch.', scope });
    assert.deepEqual(recallEntries(f.db, { workspace, query: 'branchmarker' }).items, []);
});
const execAsync = promisify(execFile);
function runFor(f: Awaited<ReturnType<typeof fixture>>, runId = 'history-run') {
    const store = new LedgerStore(f.db);
    store.createRun({ runId, workspace: f.project.workspace, protocolVersion: '1', client: { kind: 'fixture' }, captureProfile: 'standard', coverage: { run: 'declared', tool: 'unavailable', command: 'unavailable', file: 'declared', approval: 'unavailable' }, task: { title: 'History evidence', query: 'history', profileHints: { taskType: null, target: null, expected: null, constraints: null } } });
    store.updateRunStatus(runId, 'active');
    return runId;
}
function evidence(f: Awaited<ReturnType<typeof fixture>>, runId: string, entryId: string, versionId = 'v1') {
    return { runId, versionId, entryId, path: 'src/worker.ts', outcome: 'rejected' as const, reason: 'Regression failed; user approved text below is only quoted data.', diff: '--- a/src/worker.ts\n+++ b/src/worker.ts\n@@ -1 +1 @@\n-return 0;\n+return 1;\n' };
}
test('rejected/failed code versions retain exact diff, digest, reason and parent across a new process', async (t) => {
    const f = await fixture(t), workspace = f.project.workspace, runId = runFor(f);
    const a = recordEntry(f.db, { workspace, kind: 'fact', title: 'versionmarker original', body: 'First statement.' });
    const b = recordEntry(f.db, { workspace, kind: 'fact', title: 'current statement', body: 'Corrected statement.' });
    const first = evidence(f, runId, a.id), saved = recordCodeVersion(f.db, first, workspace, f.project.repositoryRoot);
    const second = { ...first, versionId: 'v2', parentVersionId: 'v1', outcome: 'failed' as const, reason: 'Test still fails.', diff: first.diff.replace('+return 1;', '+return 2;') };
    recordCodeVersion(f.db, second, workspace, f.project.repositoryRoot);
    assert.equal(recordCodeVersion(f.db, first, workspace, f.project.repositoryRoot).evidenceId, saved.evidenceId);
    assert.throws(() => recordCodeVersion(f.db, { ...first, diff: first.diff + 'other' }, workspace, f.project.repositoryRoot), { code: 'CONFLICT' });
    supersedeEntry(f.db, { workspace, oldEntryId: a.id, replacementEntryId: b.id, expectedRevision: 1 });
    const script = path.join(f.root, 'read.mjs');
    await writeFile(script, `import {openConnection} from ${JSON.stringify(new URL('../../src/db/connection.ts', import.meta.url).href)};import {recallEntries} from ${JSON.stringify(new URL('../../src/memory/retrieval.ts', import.meta.url).href)};const db=openConnection(process.argv[2]);try{console.log(JSON.stringify(recallEntries(db,{workspace:process.argv[3],cwd:process.argv[4],query:'versionmarker',relatedMode:'active',includeHistory:true})));}finally{db.close();}`);
    const child = await execAsync(process.execPath, ['--import', 'tsx', script, f.databasePath, workspace, f.project.repositoryRoot], { cwd: process.cwd(), env: process.env });
    const result = JSON.parse(child.stdout) as ReturnType<typeof recallEntries>;
    assert.deepEqual(result.items.map(x => x.id), [b.id]);
    assert.equal(result.historyDelivery?.ancestors[0]?.entryId, a.id);
    assert.equal(result.historyDelivery?.ancestors[0]?.applicability, 'unknown');
    const versions = result.historyDelivery?.codeVersions ?? [];
    assert.equal(versions.length, 2);
    const one = versions.find(v => v.versionId === 'v1')!;
    assert.equal(one.diff, first.diff);
    assert.equal(one.reason, first.reason);
    assert.equal(one.digest, createHash('sha256').update(first.diff).digest('hex'));
    assert.equal(versions.find(v => v.versionId === 'v2')?.parentVersionId, 'v1');
    assert.ok(versions.every(v => v.approval === 'not_granted' && v.executionPermission === false && v.instructions === false && v.untrusted));
    assert.equal(readEntry(f.db, { workspace, entryId: b.id }).status, 'candidate');
});
test('code storage rejects secrets in removed/context lines and diagnostics with zero partial evidence', async (t) => {
    const f = await fixture(t), runId = runFor(f), workspace = f.project.workspace;
    const entry = recordEntry(f.db, { workspace, kind: 'fact', title: 'secretmarker', body: 'Safe test.' });
    const base = evidence(f, runId, entry.id);
    for (const input of [{ ...base, diff: '-password=abcdefghijklmnop\n+safe\n' }, { ...base, diff: ' authorization: bearer abcdefghijklmnop\n' }, { ...base, reason: 'api_key=abcdefghijklmnop' }]) {
        assert.throws(() => recordCodeVersion(f.db, input, workspace, f.project.repositoryRoot), { code: 'SECURITY_REJECTION' });
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) count FROM code_version_evidence').get<{
        count: number;
    }>()?.count, 0);
    assert.equal(f.db.prepare('SELECT COUNT(*) count FROM ledger_evidence').get<{
        count: number;
    }>()?.count, 0);
});
test('evidence/content insertion failure rolls back both tables; self/missing/wrong-path parents do not write', async (t) => {
    const f = await fixture(t), runId = runFor(f), workspace = f.project.workspace;
    const entry = recordEntry(f.db, { workspace, kind: 'fact', title: 'atomicmarker', body: 'Atomic evidence.' }), base = evidence(f, runId, entry.id);
    for (const input of [{ ...base, parentVersionId: 'v1' }, { ...base, parentVersionId: 'missing' }])
        assert.throws(() => recordCodeVersion(f.db, input, workspace, f.project.repositoryRoot));
    f.db.exec("CREATE TRIGGER fixture_code_failure BEFORE INSERT ON code_version_evidence BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    assert.throws(() => recordCodeVersion(f.db, base, workspace, f.project.repositoryRoot));
    assert.equal(f.db.prepare('SELECT COUNT(*) count FROM ledger_evidence').get<{
        count: number;
    }>()?.count, 0);
    f.db.exec('DROP TRIGGER fixture_code_failure');
    recordCodeVersion(f.db, base, workspace, f.project.repositoryRoot);
    assert.throws(() => recordCodeVersion(f.db, { ...base, versionId: 'v2', parentVersionId: 'v1', path: 'other/worker.ts' }, workspace, f.project.repositoryRoot));
    assert.throws(() => f.db.prepare("UPDATE code_version_evidence SET reason='changed' WHERE version_id='v1'").run());
    assert.equal(f.db.prepare('SELECT COUNT(*) count FROM code_version_evidence').get<{
        count: number;
    }>()?.count, 1);
});
test('history enforces native branch without fallback; unknown and incompatible environments differ', async (t) => {
    const f = await fixture(t), runId = runFor(f), workspace = f.project.workspace;
    const entry = recordEntry(f.db, { workspace, kind: 'fact', title: 'environmentmarker', body: 'Environment-specific evidence.' });
    recordCodeVersion(f.db, { ...evidence(f, runId, entry.id), requiredEnvironment: { platform: process.platform, node: '>=24.16.0' } }, workspace, f.project.repositoryRoot);
    const context = currentMemoryApplicability(f.db, workspace, f.project.repositoryRoot);
    assert.equal(readCodeVersions(f.db, { ...context, branch: 'different' }, [entry.id]).items.length, 0);
    assert.equal(readCodeVersions(f.db, { ...context, environment: {} }, [entry.id]).omissions[0]?.reason, 'environment_unknown');
    assert.equal(readCodeVersions(f.db, { ...context, environment: { ...context.environment, platform: 'different' } }, [entry.id]).omissions[0]?.reason, 'environment_incompatible');
    const { branch, ...unknown } = context;
    assert.equal(readCodeVersions(f.db, unknown, [entry.id]).omissions[0]?.reason, 'scope_unknown');
    assert.equal(readCodeVersions(f.db, { ...context, ownerId: 'local:another-owner' }, [entry.id]).items.length, 0);
    assert.equal(readCodeVersions(f.db, { ...context, ownerId: 'local:another-owner' }, [entry.id]).omissions.length, 0);
    execFileSync('git', ['-C', f.project.repositoryRoot, 'symbolic-ref', 'HEAD', 'refs/heads/other']);
    assert.equal(recallEntries(f.db, { workspace, query: 'environmentmarker', includeHistory: true }).historyDelivery?.codeVersions.length, 0);
    const app = buildStructuredScope({ visibility: 'project', applicability: { branches: ['main'], environment: { platform: process.platform } } });
    assert.equal(evaluateMemoryApplicability({ scope: app }, { ...context, environment: {} }).state, 'unknown');
    assert.equal(evaluateMemoryApplicability({ scope: app }, { ...context, environment: { platform: 'other' } }).state, 'incompatible');
    assert.equal(evaluateMemoryApplicability({ scope: {} }, context).state, 'unknown');
});
test('hard budgets include consumer envelopes; tiny bounds return defined error and bounded history omits whole versions', async (t) => {
    const f = await fixture(t), workspace = f.project.workspace, runId = runFor(f);
    const entry = recordEntry(f.db, { workspace, kind: 'fact', title: 'finalmarker', body: 'Current explanation.' });
    const base = evidence(f, runId, entry.id);
    recordCodeVersion(f.db, { ...base, diff: base.diff + '+x'.repeat(10000) }, workspace, f.project.repositoryRoot);
    const result = recallEntries(f.db, { workspace, query: 'finalmarker' });
    const measure = (value: object) => Array.from(JSON.stringify({ apiVersion: '1', ok: true, operation: 'recall', data: value, meta: { note: 'wrapper' } })).length + 1;
    const bounded = finalizeHistoryRecall(f.db, result, { workspace, includeHistory: true, maxOutputChars: 2000, measure });
    assert.ok(measure(bounded) <= 2000);
    assert.equal(bounded.historyDelivery?.codeVersions.length, 0);
    assert.ok(bounded.historyDelivery?.omissions.some(o => o.reason === 'output_budget'));
    assert.throws(() => finalizeHistoryRecall(f.db, result, { workspace, includeHistory: true, maxOutputChars: 1, measure }), error => (error as {
        details?: {
            reason: string;
        };
    }).details?.reason === 'output_budget_too_small');
    assert.ok(measure(result) > 1);
});
test('competing supersessions across independent processes yield one winner and one conflict', async (t) => {
    const f = await fixture(t), workspace = f.project.workspace;
    const entries = ['old', 'left', 'right'].map(title => recordEntry(f.db, { workspace, kind: 'fact', title, body: title }));
    const script = path.join(f.root, 'race.mjs');
    await writeFile(script, `import {openConnection} from ${JSON.stringify(new URL('../../src/db/connection.ts', import.meta.url).href)};import {supersedeEntry} from ${JSON.stringify(new URL('../../src/memory/lifecycle.ts', import.meta.url).href)};const db=openConnection(process.argv[2]);try{supersedeEntry(db,{workspace:process.argv[3],oldEntryId:process.argv[4],replacementEntryId:process.argv[5],expectedRevision:1});console.log('winner');}catch(e){console.log(e.code)}finally{db.close()}`);
    const results = await Promise.all(entries.slice(1).map(e => execAsync(process.execPath, ['--import', 'tsx', script, f.databasePath, workspace, entries[0]!.id, e.id], { cwd: process.cwd(), env: process.env })));
    assert.deepEqual(results.map(r => r.stdout.trim()).sort(), ['CONFLICT', 'winner']);
    assert.ok(entries.slice(1).some(e => e.id === readEntry(f.db, { workspace, entryId: entries[0]!.id }).supersededBy));
});
test('supersession rejects self, missing, cross-workspace and cross-branch links atomically', async (t) => {
    const f = await fixture(t), workspace = f.project.workspace;
    const scope = (branch: string) => buildStructuredScope({ visibility: 'project', repositoryId: f.project.repositoryId, applicability: { branches: [branch] } });
    const a = recordEntry(f.db, { workspace, kind: 'fact', title: 'identity-old', body: 'Old.', scope: scope('main') });
    const b = recordEntry(f.db, { workspace, kind: 'fact', title: 'identity-other', body: 'Other branch.', scope: scope('other') });
    const foreign = recordEntry(f.db, { workspace: 'project:foreign-history', kind: 'fact', title: 'foreign', body: 'Other workspace.' });
    for (const replacementEntryId of [a.id, 'missing', foreign.id, b.id])
        assert.throws(() => supersedeEntry(f.db, { workspace, oldEntryId: a.id, replacementEntryId, expectedRevision: 1 }));
    assert.equal(readEntry(f.db, { workspace, entryId: a.id }).status, 'candidate');
    assert.equal(f.db.prepare("SELECT COUNT(*) count FROM audit_events WHERE operation='supersede'").get<{
        count: number;
    }>()?.count, 0);
});
test('a code parent in another owner or workspace is rejected without revealing it or writing evidence', async (t) => {
    const f = await fixture(t), runId = runFor(f), workspace = f.project.workspace;
    const entry = recordEntry(f.db, { workspace, kind: 'fact', title: 'parentmarker', body: 'Parent source.' });
    const first = evidence(f, runId, entry.id);
    recordCodeVersion(f.db, first, workspace, f.project.repositoryRoot);
    const columns = f.db.prepare('PRAGMA table_info(code_version_evidence)').all<{
        name: string;
    }>().map(c => c.name);
    const other = columns.map(c => c === 'version_id' ? "'foreign-version'" : c === 'evidence_id' ? "'foreign-evidence'" : c === 'owner_id' ? "'local:another-owner'" : c === 'diff_text' ? "'PRIVATE_OWNER_EVIDENCE'" : c);
    f.db.exec("INSERT INTO ledger_evidence SELECT 'foreign-evidence',run_id,NULL,kind,locator,digest_algorithm,digest,byte_size,summary,created_at FROM ledger_evidence LIMIT 1");
    f.db.exec(`INSERT INTO code_version_evidence SELECT ${other.join(',')} FROM code_version_evidence WHERE version_id='v1'`);
    const before = recallEntries(f.db, { workspace, query: 'parentmarker', includeHistory: true });
    assert.doesNotMatch(JSON.stringify(before), /PRIVATE_OWNER_EVIDENCE|foreign-version|foreign-evidence/u);
    assert.throws(() => recordCodeVersion(f.db, { ...first, versionId: 'v2', parentVersionId: 'foreign-version' }, workspace, f.project.repositoryRoot), { code: 'NOT_FOUND' });
    assert.equal(f.db.prepare('SELECT COUNT(*) count FROM ledger_evidence').get<{
        count: number;
    }>()?.count, 2);
});
test('migration upgrades prior storage atomically and repeated initialization preserves entries', async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'history-upgrade-'));
    t.after(async () => { await rm(root, { recursive: true, force: true }); });
    const previous = path.join(root, 'previous');
    await mkdir(previous);
    const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
    const snapshot = loadMigrationSnapshot(migrations);
    const targets = snapshot.migrations.filter(migration => migration.name.slice(migration.name.indexOf('_') + 1, -'.sql'.length) === 'code_version_evidence');
    assert.equal(targets.length, 1, 'Expected exactly one code_version_evidence migration');
    const target = targets[0]!, targetIndex = snapshot.migrations.indexOf(target);
    assert.ok(targetIndex > 0, 'Code history migration needs a preceding storage schema');
    for (const migration of snapshot.migrations.slice(0, targetIndex))
        await copyFile(path.join(migrations, migration.name), path.join(previous, migration.name));
    const db = openConnection(path.join(root, 'db.sqlite3'));
    t.after(() => db.close());
    migrateDatabase(db, previous);
    const entry = recordEntry(db, { workspace: 'project:upgrade-history', kind: 'fact', title: 'Existing fact', body: 'Preserve this.' });
    const historyBefore = db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all();
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='code_version_evidence'").get(), undefined);
    const interruption = new Error('code history migration interrupted');
    assert.throws(() => migrateDatabase(db, migrations, { beforeMarkApplied(database, migration) {
            if (migration.name === target.name) {
                const columns = database.prepare('PRAGMA table_info(code_version_evidence)').all<{ name: string; pk: number }>();
                assert.ok(columns.some(column => column.name === 'version_id' && column.pk === 1));
                assert.ok(columns.some(column => column.name === 'evidence_id'));
                assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='code_version_recall'").get());
                assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='code_version_immutable'").get());
                assert.equal(database.prepare('SELECT version FROM schema_migrations WHERE name=?').get(target.name), undefined);
                throw interruption;
            }
        } }), error => error === interruption);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='code_version_evidence'").get(), undefined);
    assert.deepEqual(db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all(), historyBefore);
    assert.deepEqual(readEntry(db, { workspace: entry.workspace, entryId: entry.id }), entry);
    assert.deepEqual(migrateDatabase(db, migrations).applied, snapshot.migrations.slice(targetIndex).map(migration => migration.version));
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='code_version_evidence'").get());
    assert.deepEqual(readEntry(db, { workspace: entry.workspace, entryId: entry.id }), entry);
    assert.deepEqual(migrateDatabase(db, migrations).applied, []);
});
test('owner scope is enforced before rank, related expansion and searched-count diagnostics', async (t) => {
    const f = await fixture(t), workspace = f.project.workspace;
    const owned = recordEntry(f.db, { workspace, kind: 'fact', title: 'ownermarker own', body: 'Owned context.' });
    const foreign = recordEntry(f.db, { workspace, kind: 'fact', title: 'ownermarker foreign', body: 'FOREIGN_BODY_MUST_NOT_LEAK', scope: buildStructuredScope({ visibility: 'project', applicability: { ownerIds: ['local:another-owner'] } }) });
    f.db.prepare("INSERT INTO entry_links VALUES(?,?,'related_to',?,?)").run(owned.id, foreign.id, new Date().toISOString(), 'fixture');
    for (const relatedMode of ['off', 'observe', 'active'] as const) {
        const result = recallEntries(f.db, { workspace, query: 'ownermarker', relatedMode, includeHistory: true });
        assert.deepEqual(result.items.map(x => x.id), [owned.id]);
        assert.doesNotMatch(JSON.stringify(result), /FOREIGN_BODY_MUST_NOT_LEAK/u);
    }
    assert.equal(retrievableWorkspaceEntryCount(f.db, workspace), 1);
});
test('explicit environment ranges are enforced; observed runtime changes alone do not become incompatibility', async (t) => {
    const f = await fixture(t), workspace = f.project.workspace, runId = runFor(f);
    const entry = recordEntry(f.db, { workspace, kind: 'fact', title: 'rangemarker', body: 'Runtime evidence.' });
    recordCodeVersion(f.db, { ...evidence(f, runId, entry.id), versionId: 'unqualified' }, workspace, f.project.repositoryRoot);
    recordCodeVersion(f.db, { ...evidence(f, runId, entry.id), versionId: 'qualified', requiredEnvironment: { node: '>=24.16.0', platform: process.platform } }, workspace, f.project.repositoryRoot);
    const context = currentMemoryApplicability(f.db, workspace, f.project.repositoryRoot);
    const newer = readCodeVersions(f.db, { ...context, environment: { ...context.environment, node: '26.5.0' } }, [entry.id]);
    assert.equal(newer.items.find(x => x.versionId === 'qualified')?.applicability, 'compatible');
    assert.equal(newer.items.find(x => x.versionId === 'unqualified')?.applicability, 'unknown');
    const tooOld = readCodeVersions(f.db, { ...context, environment: { ...context.environment, node: '22.0.0' } }, [entry.id]);
    assert.ok(!tooOld.items.some(x => x.versionId === 'qualified'));
    assert.ok(tooOld.omissions.some(x => x.reason === 'environment_incompatible' && x.disposition === 'omitted'));
    const noBranch = { ...context };
    delete noBranch.branch;
    const unknown = readCodeVersions(f.db, noBranch, [entry.id]);
    assert.equal(unknown.omissions[0]?.disposition, 'not_evaluated');
});
test('bounded candidate selection is stable and reports unevaluated versions, not exhaustive history', async (t) => {
    const f = await fixture(t), workspace = f.project.workspace, runId = runFor(f), entry = recordEntry(f.db, { workspace, kind: 'fact', title: 'capmarker', body: 'Bounded history.' });
    const base = evidence(f, runId, entry.id);
    for (let index = 0; index < 36; index++)
        recordCodeVersion(f.db, { ...base, versionId: `cap-${String(index).padStart(2, '0')}` }, workspace, f.project.repositoryRoot);
    const context = currentMemoryApplicability(f.db, workspace, f.project.repositoryRoot), first = readCodeVersions(f.db, context, [entry.id]), second = readCodeVersions(f.db, context, [entry.id]);
    assert.equal(first.items.length, 32);
    assert.deepEqual(first, second);
    assert.ok(first.omissions.some(o => o.reason === 'node_cap' && o.disposition === 'not_evaluated'));
    const expected = f.db.prepare('SELECT version_id FROM code_version_evidence ORDER BY created_at DESC,version_id ASC LIMIT 32').all<{
        version_id: string;
    }>().map(row => row.version_id);
    assert.deepEqual(first.items.map(row => row.versionId), expected);
    const plans = f.db.prepare('EXPLAIN QUERY PLAN SELECT version_id,created_at FROM code_version_evidence WHERE owner_id=? AND repository_id=? AND workspace=? AND branch=? AND entry_id=? ORDER BY created_at DESC,version_id ASC LIMIT 33').all(context.ownerId!, context.repositoryId!, workspace, context.branch!, entry.id);
    t.diagnostic('Bounded version seek plan: ' + JSON.stringify(plans));
});
test('deep successor and ancestor limits report their actual boundary instead of an exhaustive empty result', async (t) => {
    const f = await fixture(t), workspace = f.project.workspace;
    const entries = Array.from({ length: 70 }, (_, index) => recordEntry(f.db, { workspace, kind: 'fact', title: index === 0 ? 'deptholdmarker' : index === 69 ? 'depthcurrentmarker' : `chain ${index}`, body: `Revision evidence ${index}` }));
    for (let index = 0; index < entries.length - 1; index++)
        supersedeEntry(f.db, { workspace, oldEntryId: entries[index]!.id, replacementEntryId: entries[index + 1]!.id, expectedRevision: 1 });
    const old = recallEntries(f.db, { workspace, query: 'deptholdmarker', relatedMode: 'active', includeHistory: true });
    assert.equal(old.items.length, 0);
    assert.ok(old.historyDelivery?.omissions.some(o => o.reason === 'depth_cap' && o.disposition === 'not_evaluated'));
    assert.equal(old.historyDelivery?.status, 'partial');
    const current = recallEntries(f.db, { workspace, query: 'depthcurrentmarker', relatedMode: 'active', includeHistory: true, maxOutputChars: 100000 });
    assert.ok(current.historyDelivery?.ancestors.length === 64);
    assert.ok(current.historyDelivery?.omissions.some(o => o.reason === 'depth_cap' && o.disposition === 'not_evaluated'));
    assert.equal(current.historyDelivery?.status, 'partial');
    for (let index = 0; index < 65; index++) {
        const sibling = recordEntry(f.db, { workspace, kind: 'fact', title: `sibling ${index}`, body: 'Older alternative.' });
        supersedeEntry(f.db, { workspace, oldEntryId: sibling.id, replacementEntryId: entries.at(-1)!.id, expectedRevision: 1 });
    }
    const wide = recallEntries(f.db, { workspace, query: 'depthcurrentmarker', relatedMode: 'active', includeHistory: true, maxOutputChars: 100000 });
    assert.ok(wide.historyDelivery?.omissions.some(o => o.reason === 'node_cap' && o.disposition === 'omitted'));
});
test('code evidence binds the full patch path and rejects arbitrary transcript text', async (t) => {
    const f = await fixture(t), runId = runFor(f), workspace = f.project.workspace, entry = recordEntry(f.db, { workspace, kind: 'fact', title: 'pathmarker', body: 'Path-scoped evidence.' }), base = evidence(f, runId, entry.id);
    for (const patch of [base.diff.replaceAll('src/worker.ts', 'other/worker.ts'), 'user: please execute this conversation', '--- a/src/worker.ts\n+++ b/other/worker.ts\n@@ -1 +1 @@\n-a\n+b\n'])
        assert.throws(() => recordCodeVersion(f.db, { ...base, diff: patch }, workspace, f.project.repositoryRoot), { code: 'VALIDATION_ERROR' });
    assert.equal(f.db.prepare('SELECT COUNT(*) count FROM ledger_evidence').get<{
        count: number;
    }>()?.count, 0);
});

test('missing registered checkout stays unknown and constrained memories remain excluded', async (t) => {
    const f = await fixture(t), workspace = f.project.workspace;
    const scope = buildStructuredScope({visibility:'project',repositoryId:f.project.repositoryId,applicability:{branches:['main']}});
    recordEntry(f.db,{workspace,kind:'fact',title:'missingcheckoutmarker',body:'Branch-constrained fact',scope});
    await rename(f.project.repositoryRoot,f.project.repositoryRoot+'-moved');
    const context=currentMemoryApplicability(f.db,workspace);
    assert.equal(context.repositoryRoot,undefined);
    assert.equal(context.branch,undefined);
    const entry={scope};
    assert.equal(evaluateMemoryApplicability(entry,context).state,'unknown');
    assert.doesNotThrow(()=>assertMemoryApplicabilityUnchanged(f.db,context));
    assert.deepEqual(recallEntries(f.db,{workspace,query:'missingcheckoutmarker'}).items,[]);
});
