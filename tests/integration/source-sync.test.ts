import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import {
  OFFICIAL_SOURCES,
  persistOfficialSourceSync,
  prepareOfficialSourceSync,
  syncOfficialSources,
  type FetchImpl,
} from '../../src/knowledge/sources.js';

const migrations = path.resolve(import.meta.dirname, '../../migrations');
const now = '2026-08-20T00:00:00.000Z';
const profile = { taskType: 'build' as const, target: 'src/app.ts', expected: 'tests pass', constraints: null };

async function createDatabase() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-source-sync-'));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database, migrations);
  return database;
}

const fakeFetch: FetchImpl = (input) => {
  const url = String(input);
  const body = url.includes('/commits/')
    ? JSON.stringify({ sha: 'test-sentinel-1' })
    : url.includes('/git/trees/')
      ? JSON.stringify({ tree: [{ path: 'skills/local/SKILL.md', type: 'blob' }] })
      : '# Local build skill\n\nTests pass.';
  return Promise.resolve({ ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) } as unknown as Response);
};

function input(database: ReturnType<typeof openConnection>) {
  return { database, workspace: 'source-workspace', task: 'Implement src/app.ts', profile, recommendedTags: ['bot:builder'], fetchImpl: fakeFetch, now };
}

test('preparation performs bounded network work without a database and persistence replays exactly', async () => {
  const prepared = await prepareOfficialSourceSync({ workspace: 'source-workspace', task: 'Implement src/app.ts', profile, recommendedTags: ['bot:builder'], fetchImpl: fakeFetch });
  assert.equal(prepared.attempted, true);
  assert.deepEqual(prepared.sources.map((source) => source.sourceId), OFFICIAL_SOURCES.map((source) => source.id).sort());
  assert.equal(prepared.sources.every((source) => source.commit === 'test-sentinel-1'), true);
  assert.equal(prepared.sources.every((source) => source.documents.length === 1), true);

  const database = await createDatabase();
  const first = persistOfficialSourceSync(database, { workspace: 'source-workspace', prepared, now });
  const second = persistOfficialSourceSync(database, { workspace: 'source-workspace', prepared, now });
  assert.equal(first.imported, 2);
  assert.equal(second.imported, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get<{ count: number }>()?.count, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get<{ count: number }>()?.count, 2);
});

test('compatibility sync awaits preparation before its one persistence transaction', async () => {
  const database = await createDatabase();
  const result = await syncOfficialSources(input(database));
  assert.equal(result.imported, 2);
  assert.deepEqual(result.sources.map((source) => source.commit), ['test-sentinel-1', 'test-sentinel-1']);
});

test('standalone persistence rolls back every source write after a late database failure', async () => {
  const prepared = await prepareOfficialSourceSync({ workspace: 'source-workspace', task: 'Implement src/app.ts', profile, recommendedTags: ['bot:builder'], fetchImpl: fakeFetch });
  const database = await createDatabase();
  database.exec(`CREATE TRIGGER force_source_failure BEFORE INSERT ON knowledge_sources BEGIN SELECT RAISE(ABORT, 'forced source failure'); END`);
  assert.throws(() => persistOfficialSourceSync(database, { workspace: 'source-workspace', prepared, now }), /forced source failure/);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM audit_events').get<{ count: number }>()?.count, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM knowledge_sources').get<{ count: number }>()?.count, 0);
});

test('partial source preparation returns one fixed safe error without leaking fetch details', async () => {
  const failingFetch: FetchImpl = (input, init) => {
    if (String(input).includes('/repos/obra/superpowers/')) return Promise.reject(new Error('SECRET token at /home/ubuntu/private'));
    return fakeFetch(input, init);
  };
  const prepared = await prepareOfficialSourceSync({ workspace: 'source-workspace', task: 'Implement src/app.ts', profile, recommendedTags: ['bot:builder'], fetchImpl: failingFetch });
  const source = prepared.sources.find((candidate) => candidate.sourceId === 'superpowers');
  assert.deepEqual(source, { sourceId: 'superpowers', commit: null, documents: [], error: 'source_unavailable' });
  assert.equal(JSON.stringify(prepared).includes('SECRET'), false);
  assert.equal(JSON.stringify(prepared).includes('/home/ubuntu/private'), false);
});
