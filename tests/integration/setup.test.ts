import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from 'jsonc-parser';
import { setupGlobalClients } from '../../src/commands/setup.js';
import { openConnection } from '../../src/db/connection.js';
import { GLOBAL_REPOSITORY_ID, GLOBAL_WORKSPACE } from '../../src/memory/workspaces.js';

async function temporaryEnvironment(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), `kiokuko-setup-${prefix}-`));
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const data = path.join(root, 'data');
  await mkdir(home, { recursive: true });
  return {
    root,
    home,
    config,
    data,
    env: { HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data },
    databasePath: path.join(data, 'kiokuko', 'kiokuko.sqlite3'),
  };
}

test('setup safely merges Codex, OpenCode, and Claude Code global configuration and is idempotent', async () => {
  const temporary = await temporaryEnvironment('merge');
  const codexDirectory = path.join(temporary.home, '.codex');
  const openCodeDirectory = path.join(temporary.config, 'opencode');
  const claudeDirectory = path.join(temporary.home, '.claude');
  await mkdir(codexDirectory, { recursive: true });
  await mkdir(openCodeDirectory, { recursive: true });
  await mkdir(claudeDirectory, { recursive: true });
  await writeFile(path.join(codexDirectory, 'config.toml'), 'model = "gpt-test"\n');
  await writeFile(path.join(codexDirectory, 'AGENTS.md'), '# Human Codex rules\n');
  await writeFile(path.join(openCodeDirectory, 'opencode.jsonc'), '{\n  // keep this comment\n  "theme": "dark",\n}\n');
  await writeFile(path.join(openCodeDirectory, 'AGENTS.md'), '# Human OpenCode rules\n');
  await writeFile(path.join(temporary.home, '.claude.json'), '{\n  "theme": "dark"\n}\n');
  await writeFile(path.join(claudeDirectory, 'CLAUDE.md'), '# Human Claude rules\n');

  const first = await setupGlobalClients({
    platform: 'linux',
    env: temporary.env,
    databasePath: temporary.databasePath,
  });
  assert.equal(first.files.length, 6);
  assert.equal(first.files.filter((file) => file.action === 'updated').length, 6);

  const codexConfig = await readFile(path.join(codexDirectory, 'config.toml'), 'utf8');
  assert.match(codexConfig, /^model = "gpt-test"/);
  assert.match(codexConfig, /\[mcp_servers\.kiokuko\]/);
  assert.match(codexConfig, /command = "kiokuko"/);
  const openCodeText = await readFile(path.join(openCodeDirectory, 'opencode.jsonc'), 'utf8');
  assert.match(openCodeText, /keep this comment/);
  const openCode = parse(openCodeText) as { theme: string; mcp: { kiokuko: { type: string; command: string[]; enabled: boolean } } };
  assert.equal(openCode.theme, 'dark');
  assert.deepEqual(openCode.mcp.kiokuko, { type: 'local', command: ['kiokuko', 'mcp'], enabled: true });
  const claude = JSON.parse(await readFile(path.join(temporary.home, '.claude.json'), 'utf8')) as { theme: string; mcpServers: { kiokuko: { type: string; command: string; args: string[]; env: object } } };
  assert.equal(claude.theme, 'dark');
  assert.deepEqual(claude.mcpServers.kiokuko, { type: 'stdio', command: 'kiokuko', args: ['mcp'], env: {} });

  for (const instructionsPath of [path.join(codexDirectory, 'AGENTS.md'), path.join(openCodeDirectory, 'AGENTS.md'), path.join(claudeDirectory, 'CLAUDE.md')]) {
    const instructions = await readFile(instructionsPath, 'utf8');
    assert.match(instructions, /^# Human/);
    assert.equal((instructions.match(/BEGIN KIOKUKO GLOBAL MEMORY/g) ?? []).length, 1);
    assert.match(instructions, /task_prepare/);
    assert.match(instructions, /task_answer/);
    assert.match(instructions, /memory_checkpoint/);
  }

  const database = openConnection(temporary.databasePath);
  try {
    const globalRow = database.prepare('SELECT repository_id AS repositoryId, workspace FROM repositories WHERE repository_id = ?').get<{ repositoryId: string; workspace: string }>(GLOBAL_REPOSITORY_ID);
    assert.equal(globalRow?.repositoryId, GLOBAL_REPOSITORY_ID);
    assert.equal(globalRow?.workspace, GLOBAL_WORKSPACE);
  } finally {
    database.close();
  }

  const before = await Promise.all(first.files.map((file) => readFile(file.path, 'utf8')));
  const second = await setupGlobalClients({ platform: 'linux', env: temporary.env, databasePath: temporary.databasePath });
  assert.ok(second.files.every((file) => file.action === 'unchanged'));
  assert.deepEqual(await Promise.all(second.files.map((file) => readFile(file.path, 'utf8'))), before);
});

test('setup dry-run validates but writes no files or database', async () => {
  const temporary = await temporaryEnvironment('dry-run');
  const result = await setupGlobalClients({
    platform: 'linux',
    env: temporary.env,
    databasePath: temporary.databasePath,
    dryRun: true,
  });
  assert.equal(result.databaseAction, 'planned');
  assert.ok(result.files.every((file) => file.action === 'created'));
  for (const file of result.files) await assert.rejects(access(file.path));
  await assert.rejects(access(temporary.databasePath));
});

test('setup refuses an unmanaged Codex kiokuko table before writing anything', async () => {
  const temporary = await temporaryEnvironment('conflict');
  const codexDirectory = path.join(temporary.home, '.codex');
  await mkdir(codexDirectory, { recursive: true });
  const configPath = path.join(codexDirectory, 'config.toml');
  const original = '[mcp_servers.kiokuko]\ncommand = "custom"\n';
  await writeFile(configPath, original);
  await assert.rejects(setupGlobalClients({
    clients: ['codex'],
    platform: 'linux',
    env: temporary.env,
    databasePath: temporary.databasePath,
  }), /unmanaged/);
  assert.equal(await readFile(configPath, 'utf8'), original);
  await assert.rejects(access(temporary.databasePath));
});
