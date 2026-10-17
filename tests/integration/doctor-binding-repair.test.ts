import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCli } from '../../src/cli.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { registerRepositoryAndLocation } from '../../src/repository/binding.js';
import { parseProjectConfigText } from '../../src/config/project-config.js';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-binding-repair-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project'); await mkdir(root);
  const databasePath = path.join(directory, 'memory.sqlite3');
  const database = openConnection(databasePath); migrateDatabase(database);
  const registration = { repositoryId: 'repo_doctor_repair', workspace: 'project:doctor-repair', displayName: 'repair', canonicalRoot: root, remoteFingerprint: null, bindingSchemaVersion: 1, agentTemplateVersion: 34 };
  registerRepositoryAndLocation(database, registration); database.close();
  return { root, databasePath, registration, bindingPath: path.join(root, '.kiokuko.json') };
}

async function invoke(databasePath: string, args: string[]) {
  let output = ''; const original = process.stdout.write, exitCode = process.exitCode;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write;
  try {
    await buildCli({ doctorDatabasePath: databasePath }).parseAsync(['node', 'kiokuko', 'doctor', '--json', ...args]);
    return { response: JSON.parse(output) as { data: { repairs?: Array<{ status: string; backupPath?: string }>; checks: { agentFiles: { findings: Array<{ reason: string }> } } } }, exitCode: process.exitCode };
  } finally { process.stdout.write = original; process.exitCode = exitCode; }
}

function registrationState(databasePath: string) {
  const db = openConnection(databasePath, { readOnly: true });
  try { return { repositories: db.prepare('SELECT * FROM repositories').all(), locations: db.prepare('SELECT * FROM repository_locations').all(), entries: db.prepare('SELECT COUNT(*) AS count FROM entries').get() }; }
  finally { db.close(); }
}

test('doctor --fix creates only the missing registered binding and is idempotent without database changes', async t => {
  const value = await fixture(t), before = registrationState(value.databasePath);
  const diagnosis = await invoke(value.databasePath, []);
  assert.ok(diagnosis.response.data.checks.agentFiles.findings.some(x => x.reason === 'missing_binding_file'));
  await assert.rejects(access(value.bindingPath), { code: 'ENOENT' });
  const repaired = await invoke(value.databasePath, ['--fix', '--repair-root', value.root]);
  assert.equal(repaired.response.data.repairs?.[0]?.status, 'created');
  const binding = parseProjectConfigText(await readFile(value.bindingPath, 'utf8'));
  assert.equal(binding.repositoryId, value.registration.repositoryId);
  assert.equal(binding.workspace, value.registration.workspace);
  assert.equal(binding.agentFile, 'AGENTS.md');
  assert.equal(binding.templateVersion, value.registration.agentTemplateVersion);
  assert.ok(repaired.response.data.checks.agentFiles.findings.some(x => x.reason === 'missing_agent_file'));
  await assert.rejects(access(path.join(value.root, 'AGENTS.md')), { code: 'ENOENT' });
  const content = await readFile(value.bindingPath, 'utf8');
  assert.equal((await invoke(value.databasePath, ['--fix', '--repair-root', value.root])).response.data.repairs?.[0]?.status, 'unchanged');
  assert.equal(await readFile(value.bindingPath, 'utf8'), content);
  assert.deepEqual(registrationState(value.databasePath), before);
});

test('doctor --fix preserves broken binding bytes in a recoverable backup before recreating it', async t => {
  const value = await fixture(t), broken = '{ invalid JSON; original user content\n';
  await writeFile(value.bindingPath, broken, { mode: 0o600 });
  const repaired = await invoke(value.databasePath, ['--fix', '--repair-root', value.root]);
  const repair = repaired.response.data.repairs?.[0]; assert.equal(repair?.status, 'recreated');
  assert.ok(repair?.backupPath); assert.equal(await readFile(repair.backupPath!, 'utf8'), broken);
  assert.equal(parseProjectConfigText(await readFile(value.bindingPath, 'utf8')).repositoryId, value.registration.repositoryId);
  assert.equal((await readdir(value.root)).filter(x => x.endsWith('.bak')).length, 1);
});

import { symlink, stat } from 'node:fs/promises';
import { repairRegisteredBindings } from '../../src/repository/binding-repair.js';
import { runDoctor } from '../../src/commands/doctor.js';

async function repair(value: Awaited<ReturnType<typeof fixture>>, options: Parameters<typeof repairRegisteredBindings>[1] = {}) {
  const database = openConnection(value.databasePath, { readOnly: true });
  try { return await repairRegisteredBindings(database, { roots: [value.root], ...options }); } finally { database.close(); }
}

test('repair refuses a symlink, including a dangling symlink, and preserves its target', async t => {
  for (const dangling of [false, true]) {
    const value = await fixture(t), outside = path.join(path.dirname(value.root), 'outside');
    if (!dangling) await writeFile(outside, 'outside original');
    await symlink(outside, value.bindingPath);
    assert.equal((await repair(value))[0]?.status, 'refused');
    if (!dangling) assert.equal(await readFile(outside, 'utf8'), 'outside original');
    assert.equal((await readdir(value.root)).length, 1);
  }
});

test('access refusal is not treated as a missing or broken binding', async t => {
  const value = await fixture(t);
  const results = await repair(value, { readBinding: async () => { throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' }); } });
  assert.equal(results[0]?.status, 'failed');
  await assert.rejects(access(value.bindingPath), { code: 'ENOENT' });
  assert.equal((await readdir(value.root)).length, 0);
});

for (const original of [undefined, '{broken']) test(`concurrent ${original === undefined ? 'creation' : 'change'} is never overwritten`, async t => {
  const value = await fixture(t); if (original !== undefined) await writeFile(value.bindingPath, original);
  const winner = JSON.stringify({ schemaVersion: 1, repositoryId: 'repo_concurrent', workspace: 'project:concurrent', agentFile: 'HUMAN.md', templateVersion: 1 });
  const results = await repair(value, { beforeWrite: () => writeFile(value.bindingPath, winner) });
  assert.equal(results[0]?.status, 'refused'); assert.equal(await readFile(value.bindingPath, 'utf8'), winner);
  if (original !== undefined) assert.equal(await readFile(results[0]!.backupPath!, 'utf8'), original);
});

test('changed recovery backup prevents replacing the broken original', async t => {
  const value = await fixture(t), broken = '{broken'; await writeFile(value.bindingPath, broken);
  const results = await repair(value, { beforeWrite: async () => {
    const backup = (await readdir(value.root)).find(x => x.endsWith('.bak'))!;
    await writeFile(path.join(value.root, backup), 'changed backup');
  } });
  assert.equal(results[0]?.status, 'refused'); assert.equal(await readFile(value.bindingPath, 'utf8'), broken);
});

test('healthy conflicting binding and directory are not classified as broken', async t => {
  const value = await fixture(t), foreign = JSON.stringify({ schemaVersion: 1, repositoryId: 'repo_other', workspace: 'project:other', agentFile: 'OTHER.md', templateVersion: 1 });
  await writeFile(value.bindingPath, foreign);
  assert.equal((await repair(value))[0]?.status, 'refused'); assert.equal(await readFile(value.bindingPath, 'utf8'), foreign);
  await rm(value.bindingPath); await mkdir(value.bindingPath);
  assert.equal((await repair(value))[0]?.status, 'failed'); assert.equal((await readdir(value.root)).length, 1);
});

test('repair accepts only exact requested registered locations', async t => {
  const value = await fixture(t), other = path.join(path.dirname(value.root), 'unregistered'); await mkdir(other);
  assert.equal((await repair(value, { roots: [other] }))[0]?.status, 'refused');
  assert.equal((await readdir(other)).length, 0); await assert.rejects(access(value.bindingPath), { code: 'ENOENT' });
  assert.equal((await repair(value, { roots: [value.root, value.root] })).length, 1);
});

test('broken schema recreation preserves a valid custom agent path and backup permissions', async t => {
  const value = await fixture(t), broken = JSON.stringify({ schemaVersion: 'invalid', agentFile: 'custom/HUMAN.md' });
  await writeFile(value.bindingPath, broken, { mode: 0o600 });
  const result = (await repair(value))[0]!; assert.equal(result.status, 'recreated');
  assert.equal(parseProjectConfigText(await readFile(value.bindingPath, 'utf8')).agentFile, 'custom/HUMAN.md');
  assert.equal((await stat(result.backupPath!)).mode & 0o777, 0o600);
});

test('read-only doctor and repair open no writable connection and cannot insert memory', async t => {
  const value = await fixture(t), before = await readFile(value.databasePath);
  const diagnosis = await runDoctor({ databasePath: value.databasePath, readOnly: true }, { openConnection: (file, options) => {
    assert.equal(options?.readOnly, true); const database = openConnection(file, options);
    assert.throws(() => database.exec("INSERT INTO repositories SELECT * FROM repositories"), /readonly/i); return database;
  } });
  assert.equal(diagnosis.checks.hybridSearch.status, 'attention');
  assert.match(diagnosis.checks.hybridSearch.detail!, /not run.*read-only/);
  assert.doesNotMatch(diagnosis.checks.hybridSearch.detail!, /corrupt|inconsistent/);
  await repair(value); assert.deepEqual(await readFile(value.databasePath), before);
});

test('registration changes during repair refuse the stale candidate', async t => {
  const value = await fixture(t);
  const results = await repair(value, { beforeWrite: () => {
    const database = openConnection(value.databasePath);
    try { database.prepare('UPDATE repositories SET workspace = ? WHERE repository_id = ?').run('project:changed', value.registration.repositoryId); }
    finally { database.close(); }
  } });
  assert.equal(results[0]?.status, 'refused'); await assert.rejects(access(value.bindingPath), { code: 'ENOENT' });
});

test('write failure leaves a broken original and recoverable backup intact', async t => {
  const value = await fixture(t), broken = '{broken'; await writeFile(value.bindingPath, broken);
  const result = (await repair(value, { beforeWrite: () => { throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' }); } }))[0]!;
  assert.equal(result.status, 'failed'); assert.equal(await readFile(value.bindingPath, 'utf8'), broken);
  assert.equal(await readFile(result.backupPath!, 'utf8'), broken);
});

test('registered root replaced with a symlink is refused before creating anything', async t => {
  const value = await fixture(t), outside = path.join(path.dirname(value.root), 'outside');
  await mkdir(outside); await rm(value.root, { recursive: true }); await symlink(outside, value.root);
  assert.equal((await repair(value))[0]?.status, 'refused'); assert.equal((await readdir(outside)).length, 0);
});
