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
  assert.equal(first.files.length, 8);
  assert.equal(first.files.filter((file) => file.action === 'updated').length, 6);
  assert.equal(first.files.filter((file) => file.action === 'created').length, 2);

  const codexConfig = await readFile(path.join(codexDirectory, 'config.toml'), 'utf8');
  assert.match(codexConfig, /^model = "gpt-test"/);
  assert.match(codexConfig, /\[mcp_servers\.kiokuko\]/);
  assert.match(codexConfig, /command = "kiokuko"/);
  const openCodeText = await readFile(path.join(openCodeDirectory, 'opencode.jsonc'), 'utf8');
  assert.match(openCodeText, /keep this comment/);
  const openCode = parse(openCodeText) as { theme: string; mcp: { kiokuko: { type: string; command: string[]; enabled: boolean } } };
  assert.equal(openCode.theme, 'dark');
  assert.deepEqual(openCode.mcp.kiokuko, { type: 'local', command: ['kiokuko', 'mcp'], enabled: true });
  const openCodeGuard = await readFile(path.join(openCodeDirectory, 'plugins', 'kiokuko-loop-guard.js'), 'utf8');
  assert.match(openCodeGuard, /MAX_AGENT_STEPS = 12/);
  assert.match(openCodeGuard, /task_prepare is limited to once per user request/);
  const claude = JSON.parse(await readFile(path.join(temporary.home, '.claude.json'), 'utf8')) as { theme: string; mcpServers: { kiokuko: { type: string; command: string; args: string[]; env: object } } };
  assert.equal(claude.theme, 'dark');
  assert.deepEqual(claude.mcpServers.kiokuko, { type: 'stdio', command: 'kiokuko', args: ['mcp'], env: {} });
  const hermesConfig = await readFile(path.join(temporary.home, '.hermes', 'config.yaml'), 'utf8');
  assert.match(hermesConfig, /Managed by `kiokuko setup`\./);
  assert.match(hermesConfig, /command: kiokuko/);
  assert.match(hermesConfig, /- mcp/);

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

test('setup resolves a sticky named Hermes profile without crossing into another profile', async () => {
  const temporary = await temporaryEnvironment('sticky-profile');
  const hermesRoot = path.join(temporary.root, 'hermes');
  const mainProfile = path.join(hermesRoot, 'profiles', 'main');
  await mkdir(mainProfile, { recursive: true });
  await writeFile(path.join(hermesRoot, 'active_profile'), 'main\n');

  const result = await setupGlobalClients({
    clients: ['hermes'],
    platform: 'linux',
    env: { ...temporary.env, HERMES_HOME: hermesRoot },
    databasePath: temporary.databasePath,
  });

  assert.deepEqual(result.files, [{
    path: path.join(mainProfile, 'config.yaml'),
    action: 'created',
    purpose: 'mcp-config',
    client: 'hermes',
  }]);
  assert.match(result.nextStep, /Hermes Agent/);
  assert.match(result.nextStep, /\/reload-mcp/);
  await access(path.join(mainProfile, 'config.yaml'));
  await assert.rejects(access(path.join(hermesRoot, 'config.yaml')));
  await assert.rejects(access(path.join(hermesRoot, 'profiles', 'default', 'config.yaml')));
});

test('a profile-shaped HERMES_HOME wins over the sticky root profile', async () => {
  const temporary = await temporaryEnvironment('profile-home');
  const hermesRoot = path.join(temporary.root, 'hermes');
  const profileHome = path.join(hermesRoot, 'profiles', 'main');
  await mkdir(profileHome, { recursive: true });
  await writeFile(path.join(hermesRoot, 'active_profile'), 'other\n');

  const result = await setupGlobalClients({
    clients: ['hermes'],
    platform: 'linux',
    env: { ...temporary.env, HERMES_HOME: profileHome },
    databasePath: temporary.databasePath,
  });

  assert.equal(result.files[0]?.path, path.join(profileHome, 'config.yaml'));
  await access(path.join(profileHome, 'config.yaml'));
  await assert.rejects(access(path.join(hermesRoot, 'profiles', 'other', 'config.yaml')));
});

test('a missing sticky Hermes profile is a fixed validation error', async () => {
  const temporary = await temporaryEnvironment('missing-profile');
  const hermesRoot = path.join(temporary.root, 'hermes');
  await mkdir(hermesRoot, { recursive: true });
  await writeFile(path.join(hermesRoot, 'active_profile'), 'missing\n');

  await assert.rejects(setupGlobalClients({
    clients: ['hermes'],
    platform: 'linux',
    env: { ...temporary.env, HERMES_HOME: hermesRoot },
    databasePath: temporary.databasePath,
  }), (error: unknown) => {
    assert.equal(error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR', true);
    assert.equal(error instanceof Error && error.message.includes('missing'), false);
    return true;
  });
  await assert.rejects(access(temporary.databasePath));
});

test('malformed sticky Hermes profile content is rejected without echoing it', async () => {
  for (const sentinel of ['../profile-secret', 'Main', 'a'.repeat(65)]) {
    const temporary = await temporaryEnvironment('malformed-profile');
    const hermesRoot = path.join(temporary.root, 'hermes');
    await mkdir(path.join(hermesRoot, 'profiles', sentinel), { recursive: true });
    await writeFile(path.join(hermesRoot, 'active_profile'), sentinel);

    await assert.rejects(setupGlobalClients({
      clients: ['hermes'],
      platform: 'linux',
      env: { ...temporary.env, HERMES_HOME: hermesRoot },
      databasePath: temporary.databasePath,
    }), (error: unknown) => {
      assert.equal(error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR', true);
      assert.equal(error instanceof Error && error.message.includes(sentinel), false);
      assert.equal(error instanceof Error && error.message.includes(hermesRoot), false);
      return true;
    });
    await assert.rejects(access(temporary.databasePath));
  }
});

test('a Hermes conflict plans no database or other client writes', async () => {
  const temporary = await temporaryEnvironment('hermes-conflict');
  const hermesHome = path.join(temporary.root, 'hermes');
  const codexDirectory = path.join(temporary.home, '.codex');
  const codexPath = path.join(codexDirectory, 'config.toml');
  await mkdir(hermesHome, { recursive: true });
  await mkdir(codexDirectory, { recursive: true });
  const originalHermes = 'mcp_servers:\n  kiokuko:\n    command: human-tool\n    args: [mcp]\n';
  await writeFile(path.join(hermesHome, 'config.yaml'), originalHermes);
  const originalCodex = 'model = "human"\n';
  await writeFile(codexPath, originalCodex);

  await assert.rejects(setupGlobalClients({
    clients: ['hermes', 'codex'],
    platform: 'linux',
    env: { ...temporary.env, HERMES_HOME: hermesHome },
    databasePath: temporary.databasePath,
  }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT');

  assert.equal(await readFile(codexPath, 'utf8'), originalCodex);
  assert.equal(await readFile(path.join(hermesHome, 'config.yaml'), 'utf8'), originalHermes);
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

test('setup refuses an unmanaged OpenCode loop guard before writing anything', async () => {
  const temporary = await temporaryEnvironment('opencode-guard-conflict');
  const openCodeDirectory = path.join(temporary.config, 'opencode');
  const pluginsDirectory = path.join(openCodeDirectory, 'plugins');
  await mkdir(pluginsDirectory, { recursive: true });
  const configPath = path.join(openCodeDirectory, 'opencode.json');
  const instructionsPath = path.join(openCodeDirectory, 'AGENTS.md');
  const guardPath = path.join(pluginsDirectory, 'kiokuko-loop-guard.js');
  const originalGuard = 'export const HumanPlugin = async () => ({})\n';
  await writeFile(configPath, '{"theme":"dark"}\n');
  await writeFile(instructionsPath, '# Human OpenCode rules\n');
  await writeFile(guardPath, originalGuard);

  await assert.rejects(setupGlobalClients({
    clients: ['opencode'],
    platform: 'linux',
    env: temporary.env,
    databasePath: temporary.databasePath,
  }), /unmanaged file/);

  assert.equal(await readFile(configPath, 'utf8'), '{"theme":"dark"}\n');
  assert.equal(await readFile(instructionsPath, 'utf8'), '# Human OpenCode rules\n');
  assert.equal(await readFile(guardPath, 'utf8'), originalGuard);
  await assert.rejects(access(temporary.databasePath));
});
