import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { getRerankerPresetDirectory } from '../../src/config/paths.js';
import { readRerankerConfig } from '../../src/reranker/config.js';
import { LOCAL_RERANKER_PRESET } from '../../src/reranker/preset.js';
import { recordEntry } from '../../src/memory/entries.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { searchEntries, searchEntriesWithReranker } from '../../src/memory/retrieval.js';
import { recallScopedMemory } from '../../src/memory/scoped-memory.js';

async function fixture(t: TestContext) {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-reranker-search-'));
  const root = path.join(base, 'repo');
  const dataDirectory = path.join(base, 'data');
  execFileSync('git', ['init', '-q', root]);
  await initializeDatabase({ databasePath: path.join(base, 'memory.sqlite3') });
  const database = openConnection(path.join(base, 'memory.sqlite3'));
  const oldMode = process.env.KIOKUKO_RERANKER_MODE;
  const oldDataDirectory = process.env.KIOKUKO_DATA_DIR;
  process.env.KIOKUKO_DATA_DIR = dataDirectory;
  t.after(async () => {
    database.close();
    await rm(base, { recursive: true, force: true });
    if (oldMode === undefined) delete process.env.KIOKUKO_RERANKER_MODE;
    else process.env.KIOKUKO_RERANKER_MODE = oldMode;
    if (oldDataDirectory === undefined) delete process.env.KIOKUKO_DATA_DIR;
    else process.env.KIOKUKO_DATA_DIR = oldDataDirectory;
  });
  const project = await resolveProjectWorkspace(database, root);
  assert.ok(project);
  recordEntry(database, {
    workspace: project.workspace, kind: 'lesson', status: 'candidate', trustLevel: 'untrusted', confidence: 0.6,
    title: 'Retry marker one', body: 'Use a bounded retry after a transient lock marker.',
    scope: buildStructuredScope({ visibility: 'project', retrievalScope: 'project-only', repositoryId: project.repositoryId }),
    createdBy: 'test',
  }, { idFactory: () => 'retry-marker-one' });
  recordEntry(database, {
    workspace: project.workspace, kind: 'fact', status: 'candidate', trustLevel: 'untrusted', confidence: 0.6,
    title: 'Retry marker two', body: 'Check the retry marker before reopening the transaction.',
    scope: buildStructuredScope({ visibility: 'project', retrievalScope: 'project-only', repositoryId: project.repositoryId }),
    createdBy: 'test',
  }, { idFactory: () => 'retry-marker-two' });
  return { database, workspace: project.workspace, root, dataDirectory };
}

test('off preserves synchronous search output; observe reports missing model without changing it', async (t) => {
  const f = await fixture(t);
  const input = { workspace: f.workspace, query: 'retry marker', limit: 10 };
  process.env.KIOKUKO_RERANKER_MODE = 'off';
  const baseline = searchEntries(f.database, input);
  assert.deepEqual(await searchEntriesWithReranker(f.database, input), baseline);
  assert.equal(readRerankerConfig().mode, 'off');

  process.env.KIOKUKO_RERANKER_MODE = 'observe';
  const observed = await searchEntriesWithReranker(f.database, input);
  assert.deepEqual(observed.items, baseline.items);
  assert.deepEqual(observed.rerankerDiagnostics, {
    mode: 'observe', state: 'unavailable', candidateCount: baseline.items.length,
    scoredCount: 0, unscoredCount: baseline.items.length, reason: 'not_found',
  });

  process.env.KIOKUKO_RERANKER_MODE = 'off';
  const scopedBaseline = await recallScopedMemory(f.database, { cwd: f.root, query: 'retry marker', limit: 10 });
  process.env.KIOKUKO_RERANKER_MODE = 'observe';
  const scopedObserved = await recallScopedMemory(f.database, { cwd: f.root, query: 'retry marker', limit: 10 });
  assert.deepEqual(scopedObserved.combined?.items, scopedBaseline.combined?.items);
  assert.deepEqual(scopedObserved.rerankerDiagnostics, {
    mode: 'observe', state: 'unavailable', candidateCount: baseline.items.length,
    scoredCount: 0, unscoredCount: baseline.items.length, reason: 'not_found',
  });
});

test('active search rejects an absent model and observe fails closed on an integrity mismatch', async (t) => {
  const f = await fixture(t);
  const input = { workspace: f.workspace, query: 'retry marker', limit: 10 };
  process.env.KIOKUKO_RERANKER_MODE = 'active';
  await assert.rejects(searchEntriesWithReranker(f.database, input), { code: 'NOT_FOUND' });
  await assert.rejects(recallScopedMemory(f.database, { cwd: f.root, query: 'retry marker', limit: 10 }), { code: 'NOT_FOUND' });

  const presetDirectory = getRerankerPresetDirectory(LOCAL_RERANKER_PRESET.id, LOCAL_RERANKER_PRESET.revision);
  await mkdir(presetDirectory, { recursive: true });
  await writeFile(path.join(presetDirectory, 'tokenizer.json'), 'corrupt');
  process.env.KIOKUKO_RERANKER_MODE = 'observe';
  await assert.rejects(searchEntriesWithReranker(f.database, input), { code: 'INTEGRITY_ERROR' });
});
