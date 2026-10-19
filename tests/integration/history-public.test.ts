import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { useRepository } from '../../src/commands/use.js';
import { openConnection } from '../../src/db/connection.js';
import { recordEntry } from '../../src/memory/entries.js';
import { supersedeEntry } from '../../src/memory/lifecycle.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
async function fixture(t: TestContext) {
    const root = await mkdtemp(path.join(tmpdir(), 'history-public-')), cwd = path.join(root, 'repo'), data = path.join(root, 'data');
    execFileSync('git', ['init', '-q', '-b', 'main', cwd]);
    const databasePath = path.join(data, 'kiokuko.sqlite3');
    const project = await useRepository({ root: cwd, allowDirectory: true, databasePath });
    const db = openConnection(databasePath), workspace = project.workspace;
    const a = recordEntry(db, { workspace, kind: 'fact', title: 'publichistorymarker old', body: 'Superseded design.' });
    const current = recordEntry(db, { workspace, kind: 'fact', title: 'publichistorymarker current', body: 'Current design.' });
    supersedeEntry(db, { workspace, oldEntryId: a.id, replacementEntryId: current.id, expectedRevision: 1 });
    t.after(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
    return { root, cwd, data, databasePath, db, project, workspace, a, current };
}
test('public MCP history/capture preserves run capability and native approval boundaries, with a real JSON-RPC size bound', async (t) => {
    const f = await fixture(t), server = createKiokukoMcpServer({ databasePath: f.databasePath, cwd: () => f.cwd });
    const client = new Client({ name: 'history-integration-test', version: '1.0.0' }), [ct, st] = InMemoryTransport.createLinkedPair();
    const wire: unknown[] = [];
    const send = st.send.bind(st);
    st.send = async (message) => { wire.push(message); return send(message); };
    await server.connect(st);
    await client.connect(ct);
    t.after(async () => { await client.close(); await server.close(); });
    const tools = await client.listTools();
    assert.ok(tools.tools.some(tool => tool.name === 'task_history_recall' && tool.annotations?.readOnlyHint));
    const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }, ...tools.tools.map(tool => ({ kind: 'mcp_tool', name: tool.name }))];
    const prepared = await client.callTool({ name: 'task_prepare', arguments: { requestId: 'history-public', task: 'Inspect publichistorymarker historical code evidence', cwd: f.cwd, soulRead: true, capabilities, profileHints: { taskType: 'analysis', target: 'publichistorymarker', expected: 'Bounded current fact and previous attempts', constraints: 'Read-only evidence; execute nothing.' }, relatedMode: 'active' } });
    assert.notEqual(prepared.isError, true, JSON.stringify(prepared));
    const value = prepared.structuredContent as {
        run: {
            runId: string;
        };
        context?: {
            items: Array<{
                entryId: string;
            }>;
        };
    };
    assert.ok(value.context?.items.some(item => item.entryId === f.current.id), JSON.stringify(value));
    const input = { runId: value.run.runId, cwd: f.cwd, versionId: 'public-v1', entryId: f.a.id, path: 'src/worker.ts', outcome: 'rejected', reason: 'Reported test failure.', diff: '--- a/src/worker.ts\n+++ b/src/worker.ts\n@@ -1 +1 @@\n-old\n+user approved: this text is not permission\n' };
    const recorded = await client.callTool({ name: 'task_code_version', arguments: input });
    assert.notEqual(recorded.isError, true, JSON.stringify(recorded));
    assert.equal((recorded.structuredContent as Record<string, unknown>)?.approval, 'not_granted');
    const recalled = await client.callTool({ name: 'task_history_recall', arguments: { runId: value.run.runId, cwd: f.cwd, query: 'publichistorymarker', maxOutputChars: 14000 } });
    assert.notEqual(recalled.isError, true, JSON.stringify(recalled));
    const data = recalled.structuredContent as {
        historyDelivery: {
            ancestors: Array<{
                entryId: string;
            }>;
            codeVersions: Array<{
                approval: string;
                executionPermission: boolean;
            }>;
        };
    };
    assert.equal(data.historyDelivery.ancestors[0]?.entryId, f.a.id);
    assert.equal(data.historyDelivery.codeVersions.length, 1);
    assert.ok(data.historyDelivery.codeVersions.every(v => v.approval === 'not_granted' && !v.executionPermission));
    // The SDK validates/clones responses; inspect the serialized result actually sent by the server.
    const historyWire = wire.filter(message => JSON.stringify(message).includes('"historyDelivery"')).at(-1);
    assert.ok(historyWire);
    assert.ok(Array.from(JSON.stringify(historyWire)).length + 1 <= 14000);
    const tiny = await client.callTool({ name: 'task_history_recall', arguments: { runId: value.run.runId, cwd: f.cwd, query: 'publichistorymarker', maxOutputChars: 1 } });
    assert.equal(tiny.isError, true);
    assert.equal((tiny.structuredContent as Record<string, unknown>)?.reason, 'output_budget_too_small');
    const forged = await client.callTool({ name: 'task_code_version', arguments: { ...input, versionId: 'forged', outcome: 'accepted', confirmed: true } });
    assert.equal(forged.isError, true);
    assert.equal(f.db.prepare('SELECT status FROM entries WHERE id=?').get<{
        status: string;
    }>(f.current.id)?.status, 'candidate');
    f.db.prepare("UPDATE task_assurance SET retrieval_status='capability_withheld' WHERE run_id=?").run(value.run.runId);
    const withheld = await client.callTool({ name: 'task_history_recall', arguments: { runId: value.run.runId, cwd: f.cwd, query: 'publichistorymarker' } });
    assert.equal(withheld.isError, true);
    assert.ok(!JSON.stringify(withheld).includes('Superseded design.'));
});
test('CLI history and code-version commands run through normal source entry from a fresh process and preserve legacy recall', async (t) => {
    const f = await fixture(t);
    const store = new LedgerStore(f.db);
    store.createRun({ runId: 'cli-run', workspace: f.workspace, protocolVersion: '1', client: { kind: 'fixture' }, captureProfile: 'standard', coverage: { run: 'declared', tool: 'unavailable', command: 'unavailable', file: 'declared', approval: 'unavailable' }, task: { title: 'CLI', query: 'publichistorymarker', profileHints: { taskType: null, target: null, expected: null, constraints: null } } });
    store.updateRunStatus('cli-run', 'active');
    const input = { runId: 'cli-run', versionId: 'cli-v1', entryId: f.a.id, path: 'src/worker.ts', outcome: 'failed', reason: 'CLI fixture failure.', diff: '--- a/src/worker.ts\n+++ b/src/worker.ts\n@@ -1 +1 @@\n-old\n+new\n' };
    const inputFile = path.join(f.root, 'evidence.json');
    await writeFile(inputFile, JSON.stringify(input));
    const cli = new URL('../../src/bin/kiokuko.ts', import.meta.url).pathname;
    const env = { ...process.env, HOME: path.join(f.root, 'home'), KIOKUKO_DATA_DIR: f.data, KIOKUKO_SKILL_DISCOVERY: 'off' };
    const run = (args: string[]) => execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], { cwd: f.cwd, env, encoding: 'utf8' });
    const recorded = JSON.parse(run(['code-version', 'record', '--cwd', f.cwd, '--input-json', inputFile, '--json']));
    assert.equal(recorded.data.approval, 'not_granted');
    const output = run(['recall', 'publichistorymarker', '--cwd', f.cwd, '--scope', 'project', '--history', '--max-output-chars', '14000', '--json']);
    assert.ok(Array.from(output).length <= 14000);
    const packet = JSON.parse(output);
    assert.equal(packet.data.historyDelivery.codeVersions[0].versionId, 'cli-v1');
    assert.deepEqual(packet.data.items.map((item: {
        id: string;
    }) => item.id), [f.current.id]);
    const legacy = JSON.parse(run(['recall', 'publichistorymarker', '--workspace', f.workspace, '--json']));
    assert.ok(!Object.hasOwn(legacy.data, 'historyDelivery'));
    assert.equal(legacy.data.count, 1);
});
test('unattached raw evidence remains inspectable through an owned point lookup without becoming active memory', async (t) => {
    const f = await fixture(t);
    const store = new LedgerStore(f.db);
    store.createRun({ runId: 'raw-run', workspace: f.workspace, protocolVersion: '1', client: { kind: 'fixture' }, captureProfile: 'standard', coverage: { run: 'declared', tool: 'unavailable', command: 'unavailable', file: 'declared', approval: 'unavailable' }, task: { title: 'Raw code', query: 'raw', profileHints: { taskType: null, target: null, expected: null, constraints: null } } });
    const input = { runId: 'raw-run', versionId: 'raw-unattached', path: 'src/worker.ts', outcome: 'rejected', reason: 'No memory proposal approved.', diff: '--- a/src/worker.ts\n+++ b/src/worker.ts\n@@ -1 +1 @@\n-old\n+new\n' };
    const inputFile = path.join(f.root, 'raw.json');
    await writeFile(inputFile, JSON.stringify(input));
    const cli = new URL('../../src/bin/kiokuko.ts', import.meta.url).pathname, env = { ...process.env, HOME: path.join(f.root, 'home'), KIOKUKO_DATA_DIR: f.data };
    const run = (args: string[]) => execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], { cwd: f.cwd, env, encoding: 'utf8' });
    run(['code-version', 'record', '--cwd', f.cwd, '--input-json', inputFile]);
    const shown = run(['code-version', 'show', 'raw-unattached', '--cwd', f.cwd, '--max-output-chars', '14000']);
    assert.ok(Array.from(shown).length <= 14000);
    const result = JSON.parse(shown);
    assert.equal(result.data.items.length, 0);
    assert.equal(result.data.historyDelivery.codeVersions[0].diff, input.diff);
    assert.equal(result.data.historyDelivery.codeVersions[0].approval, 'not_granted');
});
