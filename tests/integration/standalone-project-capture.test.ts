import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { useRepository } from '../../src/commands/use.js';
import { openConnection } from '../../src/db/connection.js';
import { readEntry } from '../../src/memory/entries.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';

const memory = { scope: 'project', kind: 'decision', basis: 'user_correction',
  title: 'README standard setup', body: 'Use the standard setup command; explain embedding opt-out separately.' };

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-standalone-project-'));
  const databasePath = path.join(root, 'memory.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  t.after(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  const project = async (name: string, registered = true) => {
    const cwd = path.join(root, name);
    await mkdir(cwd); execFileSync('git', ['init', '-q', cwd]);
    if (registered) await useRepository({ cwd, databasePath, noAgentFile: true });
    return cwd;
  };
  const connect = async (cwd: string, handler?: (message: string) => Promise<'save' | 'decline' | 'cancel'>) => {
    const server = createKiokukoMcpServer({ databasePath, cwd: () => cwd });
    const client = new Client({ name: 'codex-project-capture-test', version: '1' },
      { capabilities: handler ? { elicitation: { form: {} } } : {} });
    if (handler) client.setRequestHandler(ElicitRequestSchema, async request => {
      const choice = await handler(request.params.message);
      return choice === 'cancel' ? { action: 'cancel' } : { action: 'accept', content: { choice } };
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    const close = async () => { await client.close(); await server.close(); };
    t.after(close);
    return { client, close };
  };
  const count = (table = 'entries') => database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get<{ n: number }>()!.n;
  return { root, database, databasePath, project, connect, count };
}

test('project memory without a task or subjects reaches native approval, survives restart and stays project-scoped', async t => {
  const f = await fixture(t), cwd = await f.project('readme'), other = await f.project('other');
  let prompts = 0;
  const session = await f.connect(cwd, async message => {
    prompts++;
    assert.match(message, /Use the standard setup command/u);
    assert.match(message, /This project/u);
    assert.equal(f.count(), 0, 'no write before human consent');
    return 'save';
  });
  const input = { cwd, operationId: 'project-without-task', memories: [memory] };
  const saved = await session.client.callTool({ name: 'memory_capture', arguments: input });
  assert.equal(saved.isError, undefined);
  const data = saved.structuredContent as any;
  assert.equal(data.review.status, 'saved');
  assert.equal(prompts, 1);
  const entry = readEntry(f.database, { workspace: data.items[0].workspace, entryId: data.items[0].entryId });
  assert.equal(entry.body, memory.body);
  assert.equal(entry.scope.visibility, 'project');
  assert.equal(entry.trustLevel, 'untrusted');
  assert.equal(entry.provenance.runId, undefined);
  const retry = await session.client.callTool({ name: 'memory_capture', arguments: input });
  assert.deepEqual(retry.structuredContent, saved.structuredContent);
  assert.equal(prompts, 1);
  const moved = await session.client.callTool({ name: 'memory_capture', arguments: { ...input, cwd: other } });
  assert.equal(moved.isError, true, 'the same approval cannot be reused for another project');
  assert.equal(prompts, 1);
  await session.close();
  const restarted = await f.connect(cwd);
  const search = async (directory: string) => (await restarted.client.callTool({ name: 'memory_context',
    arguments: { cwd: directory, query: 'README standard setup' } })).structuredContent as any;
  assert.ok((await search(cwd)).entries.some((e: any) => e.entryId === entry.id));
  assert.deepEqual((await search(other)).entries, []);
  for (const table of ['ledger_runs', 'akinator_sessions', 'context_deliveries']) assert.equal(f.count(table), 0);
});

for (const choice of ['decline', 'cancel', 'unavailable'] as const) {
  test(`standalone project capture with ${choice} saves nothing`, async t => {
    const f = await fixture(t), cwd = await f.project('project');
    const { client } = await f.connect(cwd, choice === 'unavailable' ? undefined : async () => choice);
    const result = await client.callTool({ name: 'memory_capture', arguments: { cwd, operationId: choice, memories: [memory] } });
    assert.equal((result.structuredContent as any).review.status, choice === 'unavailable' ? 'unavailable' : 'declined');
    assert.equal(f.count(), 0);
  });
}

test('standalone project capture requires explicit registered cwd and never registers a project implicitly', async t => {
  const f = await fixture(t), cwd = await f.project('unknown', false);
  let prompts = 0;
  const { client } = await f.connect(cwd, async () => { prompts++; return 'save'; });
  for (const extra of [{}, { cwd }]) {
    const result = await client.callTool({ name: 'memory_capture', arguments: { ...extra, operationId: `unknown-${prompts}`, memories: [memory] } });
    assert.equal(result.isError, true);
  }
  assert.equal(prompts, 0);
  assert.equal(f.count('repository_locations'), 0);
  assert.equal(f.count(), 0);
  await assert.rejects(readFile(path.join(cwd, '.kiokuko.json')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(cwd, 'AGENTS.md')), { code: 'ENOENT' });
});

test('approval cannot move to another project if the project binding changes during review', async t => {
  const f = await fixture(t), cwd = await f.project('original'), other = await f.project('other');
  const binding = await readFile(path.join(other, '.kiokuko.json'), 'utf8');
  let prompts = 0;
  const { client } = await f.connect(cwd, async () => {
    prompts++;
    // Simulate a concurrent explicit rebind while the human is reviewing.
    const config = JSON.parse(binding);
    f.database.prepare('UPDATE repository_locations SET repository_id = ? WHERE canonical_root = ?')
      .run(config.repositoryId, cwd);
    await writeFile(path.join(cwd, '.kiokuko.json'), binding);
    return 'save';
  });
  const input = { cwd, operationId: 'bound-project', memories: [memory] };
  assert.equal((await client.callTool({ name: 'memory_capture', arguments: input })).isError, true);
  assert.equal(f.count(), 0);
  assert.equal((await client.callTool({ name: 'memory_capture', arguments: input })).isError, true);
  assert.equal(prompts, 1, 'changed project cannot reuse approval or open a duplicate prompt');
  assert.equal(f.count(), 0);
});

test('global subject memories still require subjects even when cwd is explicit', async t => {
  const f = await fixture(t), cwd = await f.project('project');
  const { client } = await f.connect(cwd, async () => { assert.fail('invalid global content must not prompt'); });
  const result = await client.callTool({ name: 'memory_capture', arguments: { cwd, operationId: 'global-without-subject',
    memories: [{ ...memory, scope: 'global', portableReason: 'Applies to README writing across projects.' }] } });
  assert.equal(result.isError, true);
  assert.equal(f.count(), 0);
});

test('lesson reinforcement without an observing run is rejected before native review', async t => {
  const f = await fixture(t), cwd = await f.project('project');
  let prompts = 0;
  const { client } = await f.connect(cwd, async () => { prompts++; return 'save'; });
  const result = await client.callTool({ name: 'memory_capture', arguments: { cwd, operationId: 'unbound-observation',
    memories: [{ ...memory, kind: 'lesson', basis: 'observed_result',
      reinforces: { entryId: 'existing-lesson', expectedRevision: 1 } }] } });
  assert.equal(result.isError, true);
  assert.equal(prompts, 0, 'a runless capture cannot claim an independent observation');
  assert.equal(f.count(), 0);
});
