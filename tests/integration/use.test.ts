import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { useRepository } from '../../src/commands/use.js';
import { openConnection } from '../../src/db/connection.js';

async function repository(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `kiokuko-use-${prefix}-`));
  execFileSync('git', ['init', '-q', root]);
  return root;
}

test('use creates binding and AGENTS.md, then is unchanged on repeat', async () => {
  const root = await repository('create');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko.sqlite3');
  const first = await useRepository({ root, databasePath });
  assert.equal(first.agentFileAction, 'created');
  assert.equal(first.bindingAction, 'created');
  const bindingBefore = await readFile(path.join(root, '.kiokuko.json'), 'utf8');
  const agentBefore = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  const second = await useRepository({ root, databasePath });
  assert.equal(second.agentFileAction, 'unchanged');
  assert.equal(second.bindingAction, 'unchanged');
  assert.equal(await readFile(path.join(root, '.kiokuko.json'), 'utf8'), bindingBefore);
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), agentBefore);
  await access(databasePath);
});

test('use creates version-3 binding, result, and repository metadata', async () => {
  const root = await repository('version');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko.sqlite3');
  const result = await useRepository({ root, databasePath });
  const binding = JSON.parse(await readFile(path.join(root, '.kiokuko.json'), 'utf8')) as { templateVersion: number };
  assert.equal(result.templateVersion, 3);
  assert.equal(binding.templateVersion, 3);

  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT agent_template_version AS version FROM repositories WHERE repository_id = ?').get<{ version: number }>(result.repositoryId)?.version, 3);
  } finally {
    database.close();
  }
});


test('use upgrades a version-1 binding and managed block without changing identity or human bytes', async () => {
  const root = await repository('upgrade');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko.sqlite3');
  const first = await useRepository({ root, databasePath, workspace: 'upgrade-workspace' });
  const bindingPath = path.join(root, '.kiokuko.json');
  const binding = JSON.parse(await readFile(bindingPath, 'utf8')) as Record<string, unknown>;
  await writeFile(bindingPath, `${JSON.stringify({ ...binding, templateVersion: 1 }, null, 2)}\n`);
  const oldManagedBlock = [
    '<!-- BEGIN KIOKUKO MANAGED BLOCK -->',
    '<!-- kiokuko-template-version: 1 -->',
    'legacy managed content',
    '<!-- END KIOKUKO MANAGED BLOCK -->',
  ].join('\r\n');
  await writeFile(path.join(root, 'AGENTS.md'), `human before\r\n${oldManagedBlock}\r\nhuman after\r\n`);

  const upgraded = await useRepository({ root, databasePath });
  const upgradedAgent = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  const upgradedBinding = JSON.parse(await readFile(bindingPath, 'utf8')) as { repositoryId: string; workspace: string; templateVersion: number };
  assert.equal(upgraded.agentFileAction, 'updated');
  assert.equal(upgraded.bindingAction, 'updated');
  assert.equal(upgraded.templateVersion, 3);
  assert.equal(upgradedBinding.repositoryId, first.repositoryId);
  assert.equal(upgradedBinding.workspace, 'upgrade-workspace');
  assert.equal(upgradedBinding.templateVersion, 3);
  assert.match(upgradedAgent, /^human before\r\n/);
  assert.match(upgradedAgent, /<!-- kiokuko-template-version: 3 -->/);
  assert.match(upgradedAgent, /\r\nhuman after\r\n$/);

  const repeatedAgent = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  const repeated = await useRepository({ root, databasePath });
  assert.equal(repeated.agentFileAction, 'unchanged');
  assert.equal(repeated.bindingAction, 'unchanged');
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), repeatedAgent);

  const database = openConnection(databasePath);
  try {
    const row = database.prepare('SELECT repository_id AS repositoryId, workspace, agent_template_version AS version FROM repositories WHERE repository_id = ?').get<{ repositoryId: string; workspace: string; version: number }>(first.repositoryId);
    assert.equal(row?.repositoryId, first.repositoryId);
    assert.equal(row?.workspace, 'upgrade-workspace');
    assert.equal(row?.version, 3);
  } finally {
    database.close();
  }
});


test('use dry-run does not create database or repository files', async () => {
  const root = await repository('dry-run');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko.sqlite3');
  const result = await useRepository({ root, databasePath, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.equal(result.templateVersion, 3);
  assert.equal(result.bindingAction, 'planned');
  assert.equal(result.agentFileAction, 'created');
  await assert.rejects(access(path.join(root, '.kiokuko.json')));
  await assert.rejects(access(path.join(root, 'AGENTS.md')));
  await assert.rejects(access(databasePath));
});

test('no-agent-file still upgrades version metadata without creating AGENTS.md', async () => {
  const root = await repository('no-agent-file');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  const databasePath = path.join(data, 'kiokuko.sqlite3');
  const result = await useRepository({ root, databasePath, noAgentFile: true });
  const binding = JSON.parse(await readFile(path.join(root, '.kiokuko.json'), 'utf8')) as { templateVersion: number };
  assert.equal(result.templateVersion, 3);
  assert.equal(result.agentFile, null);
  assert.equal(result.agentFileAction, 'skipped');
  assert.equal(result.bindingAction, 'created');
  assert.equal(binding.templateVersion, 3);
  await assert.rejects(access(path.join(root, 'AGENTS.md')));

  const database = openConnection(databasePath);
  try {
    assert.equal(database.prepare('SELECT agent_template_version AS version FROM repositories WHERE repository_id = ?').get<{ version: number }>(result.repositoryId)?.version, 3);
  } finally {
    database.close();
  }
});


test('use preserves human content and rejects malformed markers', async () => {
  const root = await repository('preserve');
  await import('node:fs/promises').then(({ writeFile }) => writeFile(path.join(root, 'AGENTS.md'), 'human\n'));
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-data-'));
  await useRepository({ root, databasePath: path.join(data, 'db.sqlite3') });
  const agent = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.match(agent, /^human\n/);
  const bindingPath = path.join(root, '.kiokuko.json');
  const bindingBefore = await readFile(bindingPath, 'utf8');
  const malformed = '<!-- BEGIN KIOKUKO MANAGED BLOCK -->\n';
  await writeFile(path.join(root, 'AGENTS.md'), malformed);
  await assert.rejects(useRepository({ root, databasePath: path.join(data, 'db.sqlite3') }), /malformed/i);
  assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), malformed);
  assert.equal(await readFile(bindingPath, 'utf8'), bindingBefore);
});
