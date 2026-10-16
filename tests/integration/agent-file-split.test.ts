import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, stat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { useRepository } from '../../src/commands/use.js';
import { AGENT_TEMPLATE_VERSION, GENERATED_AGENT_FILE, renderAgentFile, renderManagedBlock } from '../../src/agent-file/render.js';
import { BEGIN_MARKER } from '../../src/agent-file/managed-block.js';

const values = { repositoryId: 'repo-split-fixture', workspace: 'project:split-fixture', cliCommand: 'kiokuko' as const };
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'kiokuko-instruction-split-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositoryRoot = path.join(root, 'project');
  await mkdir(repositoryRoot);
  return { root: repositoryRoot, options: { root: repositoryRoot, allowDirectory: true,
    databasePath: path.join(root, 'data', 'memory.sqlite3'), ...values } };
}

test('use creates both files and repeated setup keeps the root and generated inode stable', async t => {
  const { root, options } = await fixture(t);
  await useRepository(options);
  const agent = path.join(root, 'AGENTS.md');
  const generated = path.join(root, GENERATED_AGENT_FILE);
  const initial = await readFile(agent, 'utf8');
  assert.match(initial, /Read `\.kiokuko\/AGENTS\.md` relative to the repository root/u);
  assert.doesNotMatch(initial, /task_prepare/u);
  assert.match(await readFile(generated, 'utf8'), /task_prepare/u);
  const before = [await stat(agent), await stat(generated)];
  assert.equal((await useRepository(options)).agentFileAction, 'unchanged');
  assert.equal(await readFile(agent, 'utf8'), initial);
  assert.equal((await stat(agent)).ino, before[0]!.ino);
  assert.equal((await stat(generated)).ino, before[1]!.ino);
});

test('migration preserves every byte outside the recognized Kiokuko region', async t => {
  const { root, options } = await fixture(t);
  const before = '\ufeffUser rules\r\n<!-- BEGIN OTHER PRODUCT -->\r\nOther rules\r\n<!-- END OTHER PRODUCT -->\r\n';
  const after = '\r\n\tFinal custom rules  \r\n';
  const legacy = renderManagedBlock({ ...values, templateVersion: AGENT_TEMPLATE_VERSION - 1 }).replaceAll('\n', '\r\n');
  await writeFile(path.join(root, 'AGENTS.md'), before + legacy + after);
  await useRepository(options);
  const actual = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
  assert.ok(actual.startsWith(before));
  assert.ok(actual.endsWith(after));
  assert.doesNotMatch(actual, /task_prepare/u);
  assert.match(await readFile(path.join(root, GENERATED_AGENT_FILE), 'utf8'), /task_prepare/u);
});

test('legacy root gate and generated body migrate to nonblocking instructions without losing custom rules', async t => {
  const { root, options } = await fixture(t);
  const rootPath = path.join(root, 'AGENTS.md');
  const generatedPath = path.join(root, GENERATED_AGENT_FILE);
  const oldGate = 'required_capability_unavailable is a hard stop for the task';
  const oldRoot = renderManagedBlock({ ...values, templateVersion: 33 })
    .replace('Kiokuko memory and bundled Skill routes are optional for ordinary work.', oldGate);
  const oldGenerated = renderManagedBlock({ ...values, templateVersion: 40 })
    .replace('Kiokuko memory and bundled Skill routes are optional for ordinary work.', oldGate);
  await mkdir(path.dirname(generatedPath));
  await writeFile(rootPath, `Human rules before\n${oldRoot}\nHuman rules after\n`);
  await writeFile(generatedPath, `Generated-file notes before\n${oldGenerated}\nGenerated-file notes after\n`);

  await useRepository(options);
  const rootContent = await readFile(rootPath, 'utf8');
  const generatedContent = await readFile(generatedPath, 'utf8');
  assert.ok(rootContent.startsWith('Human rules before\n'));
  assert.ok(rootContent.endsWith('Human rules after\n'));
  assert.doesNotMatch(rootContent, /task_prepare|hard stop/u);
  assert.ok(generatedContent.startsWith('Generated-file notes before\n'));
  assert.ok(generatedContent.endsWith('Generated-file notes after\n'));
  assert.doesNotMatch(generatedContent, /hard stop for the task/u);
  assert.match(generatedContent, new RegExp(`kiokuko-template-version: ${AGENT_TEMPLATE_VERSION}`));
  assert.match(generatedContent, /Never require kiokuko-soul, task_prepare, task_answer.*before authorized inspection, edits, builds, tests, reviews, or task completion/u);
  assert.equal((await useRepository(options)).agentFileAction, 'unchanged');
  assert.equal(await readFile(rootPath, 'utf8'), rootContent);
  assert.equal(await readFile(generatedPath, 'utf8'), generatedContent);
});

test('body upgrade and missing generated recovery never rewrite root instructions', async t => {
  const { root, options } = await fixture(t);
  await useRepository(options);
  const rootPath = path.join(root, 'AGENTS.md');
  const before = await readFile(rootPath, 'utf8');
  const inode = (await stat(rootPath)).ino;
  const generated = path.join(root, GENERATED_AGENT_FILE);
  await writeFile(generated, renderManagedBlock({ ...values, templateVersion: AGENT_TEMPLATE_VERSION - 1 }));
  assert.equal((await useRepository(options)).agentFileAction, 'updated');
  assert.equal(await readFile(rootPath, 'utf8'), before);
  assert.equal((await stat(rootPath)).ino, inode);
  await rm(generated);
  await useRepository(options);
  assert.match(await readFile(generated, 'utf8'), new RegExp(`kiokuko-template-version: ${AGENT_TEMPLATE_VERSION}`));
  assert.equal((await stat(rootPath)).ino, inode);
  assert.equal(renderAgentFile(before, { ...values, templateVersion: AGENT_TEMPLATE_VERSION + 1 }).action, 'unchanged');
});

test('malformed or unrecognized legacy blocks abort before changing either file', async t => {
  const { root, options } = await fixture(t);
  for (const original of [BEGIN_MARKER + '\nunfinished', BEGIN_MARKER + '\nUnknown rules\n<!-- END KIOKUKO MANAGED BLOCK -->']) {
    await writeFile(path.join(root, 'AGENTS.md'), original);
    await assert.rejects(useRepository(options), /malformed|missing its template-version/u);
    assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), original);
    await assert.rejects(readFile(path.join(root, GENERATED_AGENT_FILE)), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(root, '.kiokuko.json')), { code: 'ENOENT' });
  }
});

test('generated directory and file symlinks cannot escape repository ownership', async t => {
  const { root, options } = await fixture(t);
  const outside = path.join(path.dirname(root), 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'AGENTS.md'), 'outside unchanged');
  await symlink(outside, path.join(root, '.kiokuko'));
  await assert.rejects(useRepository(options), /symbolic link/u);
  await rm(path.join(root, '.kiokuko'));
  await mkdir(path.join(root, '.kiokuko'));
  await symlink(path.join(outside, 'AGENTS.md'), path.join(root, GENERATED_AGENT_FILE));
  await assert.rejects(useRepository(options), /symbolic link/u);
  assert.equal(await readFile(path.join(outside, 'AGENTS.md'), 'utf8'), 'outside unchanged');
  await assert.rejects(readFile(path.join(root, '.kiokuko.json')), { code: 'ENOENT' });
});

test('dry run does not create generated directory or binding', async t => {
  const { root, options } = await fixture(t);
  await useRepository({ ...options, dryRun: true });
  await assert.rejects(stat(path.join(root, '.kiokuko')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(root, '.kiokuko.json')), { code: 'ENOENT' });
});

test('root write failure rolls back the generated body and binding', async t => {
  const { root, options } = await fixture(t);
  const { atomicWriteTextIfUnchanged } = await import('../../src/agent-file/atomic-write.js');
  await assert.rejects(useRepository(options, {
    atomicWriteTextIfUnchanged: async (file, content, expectation, mode) => {
      if (file === path.join(root, 'AGENTS.md')) throw new Error('root install failed');
      return atomicWriteTextIfUnchanged(file, content, expectation, mode);
    },
  }), /root install failed/u);
  for (const file of ['AGENTS.md', GENERATED_AGENT_FILE, '.kiokuko.json']) {
    await assert.rejects(readFile(path.join(root, file)), { code: 'ENOENT' });
  }
});

test('uninstall removes generated ownership while preserving custom and foreign bytes', async t => {
  const { root, options } = await fixture(t);
  const { uninstallKiokuko } = await import('../../src/commands/uninstall.js');
  const dataRoot = path.dirname(root);
  // Align the database location with this isolated uninstall environment.
  const dataHome = path.join(dataRoot, 'xdg-data');
  const databasePath = path.join(dataHome, 'kiokuko', 'kiokuko.sqlite3');
  await useRepository({ ...options, databasePath });
  const generated = path.join(root, GENERATED_AGENT_FILE);
  const before = 'User generated-file notes\r\n';
  const after = '\r\n<!-- OTHER PRODUCT -->\r\n';
  await writeFile(generated, before + await readFile(generated, 'utf8') + after);
  await uninstallKiokuko({ platform: 'linux', env: {
    HOME: path.join(dataRoot, 'home'), XDG_DATA_HOME: dataHome,
    XDG_CONFIG_HOME: path.join(dataRoot, 'config'), XDG_RUNTIME_DIR: path.join(dataRoot, 'runtime'),
  } });
  assert.equal(await readFile(generated, 'utf8'), before + after);
  await assert.rejects(readFile(path.join(root, 'AGENTS.md')), { code: 'ENOENT' });
});
