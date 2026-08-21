import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { runCuratorCommand } from '../../src/commands/curator.js';
import { openConnection } from '../../src/db/connection.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { CURATOR_DRAFT_VERSION, curateMemoryCandidates, globalizeCuratorCandidate } from '../../src/memory/curator.js';
import { recordEntry } from '../../src/memory/entries.js';
import { registerRepositoryAndLocation } from '../../src/repository/binding.js';
import { startWebServer } from '../../src/web/server.js';
import { recallEntries } from '../../src/memory/retrieval.js';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-curator-'));
  const databasePath = path.join(directory, 'kiokuko.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  registerRepositoryAndLocation(database, {
    repositoryId: 'repo_curator_test',
    workspace: 'project:curator-test',
    displayName: 'curator-test',
    canonicalRoot: path.join(directory, 'repo'),
    remoteFingerprint: null,
    bindingSchemaVersion: 1,
    agentTemplateVersion: 1,
  });
  const reusable = recordEntry(database, {
    workspace: 'project:curator-test',
    kind: 'lesson',
    title: 'This project SQLite migration recovery workflow',
    body: 'A reusable troubleshooting workflow for this project: when a migration fails, check the applied version in /Users/example/curator-test/src/schema.sql, restore the backup, and verify the schema before retrying.',
    summary: 'A reusable workflow for safely recovering from migration failures.',
    scope: buildStructuredScope({
      visibility: 'project',
      repositoryId: 'repo_curator_test',
      memoryClass: 'troubleshooting',
      applicability: { databases: ['SQLite'], tools: ['migration'] },
      signals: { commands: ['check schema'] },
    }),
    tags: ['workflow', 'skill:database'],
  });
  const localOnly = recordEntry(database, {
    workspace: 'project:curator-test',
    kind: 'decision',
    title: 'This repository only decision',
    body: `Change /Users/example/project/src/private.ts only in this repository.`,
  });
  return { directory, databasePath, database, reusable, localOnly };
}

test('curator identifies reusable candidates and globalizes only after explicit service call', async () => {
  const data = await fixture();
  try {
    for (let index = 0; index < 5; index += 1) recallEntries(data.database, { workspace: 'project:curator-test', query: 'SQLite migration recovery' });
    const listed = await curateMemoryCandidates(data.database, { workspace: 'project:curator-test' });
    assert.deepEqual(listed.candidates.map((candidate) => candidate.entryId), [data.reusable.id]);
    const candidate = listed.candidates[0];
    assert.ok(candidate);
    assert.equal(candidate.skillName, 'SQLite migration recovery workflow');
    assert.equal(candidate.knowledge.qualifiedHits, 0, 'retrieval frequency is not a qualified hit');
    assert.equal(candidate.knowledge.skillReady, false);
    assert.equal(candidate.overview.length, 3);
    assert.match(candidate.overview[1], /troubleshooting workflow for the target project/u);
    assert.equal(candidate.draft.version, CURATOR_DRAFT_VERSION);
    assert.match(candidate.draft.body, /^Purpose\n/u);
    assert.match(candidate.draft.body, /Procedure/u);
    assert.match(candidate.draft.body, /Applicability/u);
    assert.ok(candidate.draft.changes.includes('project-references-normalized'));
    assert.ok(candidate.draft.changes.includes('paths-generalized'));
    assert.doesNotMatch(JSON.stringify(candidate.draft), /(?:This project|\/Users\/example|repo_curator_test|project:curator-test)/u);

    const result = globalizeCuratorCandidate(data.database, {
      workspace: 'project:curator-test',
      entryId: data.reusable.id,
      expectedRevision: data.reusable.revision,
    });
    assert.equal(result.idempotent, false);
    assert.equal(result.global.workspace, 'global');
    assert.equal(result.global.status, 'candidate');
    assert.equal(result.global.scope.visibility, 'global');
    assert.equal(result.global.provenance.type, 'curator_globalize');
    assert.equal(result.global.provenance.reference, `${data.reusable.id}@${data.reusable.revision}#${CURATOR_DRAFT_VERSION}`);
    assert.equal(result.global.title, candidate.draft.title);
    assert.equal(result.global.summary, candidate.draft.summary);
    assert.equal(result.global.body, candidate.draft.body);
    assert.notEqual(result.global.body, data.reusable.body);
    assert.doesNotMatch(JSON.stringify({ title: result.global.title, summary: result.global.summary, body: result.global.body }), /(?:This project|\/Users\/example|repo_curator_test|project:curator-test)/u);
    assert.ok(result.global.tags.includes('skill:curated'));
    assert.ok(result.global.tags.includes(`curator:${CURATOR_DRAFT_VERSION}`));

    const replay = globalizeCuratorCandidate(data.database, {
      workspace: 'project:curator-test',
      entryId: data.reusable.id,
      expectedRevision: data.reusable.revision,
    });
    assert.equal(replay.idempotent, true);
    assert.equal(replay.global.id, result.global.id);
    assert.equal(data.database.prepare('SELECT COUNT(*) AS count FROM entries WHERE workspace = ?').get<{ count: number }>('global')?.count, 1);
  } finally {
    data.database.close();
  }
});

test('curator command supports explicit batch confirmation', async () => {
  const data = await fixture();
  try {
    const output: string[] = [];
    const result = await runCuratorCommand(data.database, {
      workspace: 'project:curator-test',
      yes: true,
      output: { write: (value: string) => { output.push(value); return true; } } as NodeJS.WritableStream,
    });
    assert.equal(result.globalized.length, 1);
    assert.match(output.join(''), /スキル名:/);
    assert.match(output.join(''), /再生成ドラフト:/);
    assert.match(output.join(''), /Purpose/);
    assert.match(output.join(''), /Globalに追加しました/);
  } finally {
    data.database.close();
  }
});

test('web exposes curator candidates and a revision-checked globalize action', async () => {
  const data = await fixture();
  const web = await startWebServer({ databasePath: data.databasePath, host: '127.0.0.1', port: 0 });
  try {
    const home = await fetch(web.url);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /id="curator-button"/);

    const sessionResponse = await fetch(web.url);
    const cookie = sessionResponse.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie);
    const headers = { cookie: cookie as string };
    const listedResponse = await fetch(`${web.url}/api/curator/candidates?workspace=project%3Acurator-test`, { headers });
    assert.equal(listedResponse.status, 200);
    const listed = await listedResponse.json() as { candidates: Array<{ entryId: string; revision: number; draft: { body: string; version: string } }> };
    assert.equal(listed.candidates[0]?.entryId, data.reusable.id);
    assert.equal(listed.candidates[0]?.draft.version, CURATOR_DRAFT_VERSION);
    assert.doesNotMatch(listed.candidates[0]?.draft.body ?? '', /\/Users\/example/u);

    const globalizedResponse = await fetch(`${web.url}/api/curator/globalize?workspace=project%3Acurator-test`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ entryId: data.reusable.id, expectedRevision: data.reusable.revision }),
    });
    assert.equal(globalizedResponse.status, 200);
    const globalized = await globalizedResponse.json() as { global: { workspace: string; body: string } };
    assert.equal(globalized.global.workspace, 'global');
    assert.equal(globalized.global.body, listed.candidates[0]?.draft.body);
  } finally {
    await web.close();
    data.database.close();
  }
});
