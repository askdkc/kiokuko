import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { parse } from 'jsonc-parser';
import { buildCli } from '../../src/cli.js';
import { SETUP_CLIENTS, setupGlobalClients } from '../../src/commands/setup.js';
import { uninstallKiokuko } from '../../src/commands/uninstall.js';
import { useRepository } from '../../src/commands/use.js';
import { getDatabaseLockPath } from '../../src/config/paths.js';
import { KiokukoError } from '../../src/errors.js';
import { applyTextRemoval } from '../../src/uninstall/files.js';
import { removeLegacyHooks } from '../../src/uninstall/render.js';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kiokuko-uninstall-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const config = path.join(root, 'config');
  const runtime = path.join(root, 'runtime');
  await mkdir(home);
  const env = { HOME: home, XDG_CONFIG_HOME: config, XDG_DATA_HOME: data, XDG_RUNTIME_DIR: runtime, PATH: '' };
  const options = { platform: 'linux' as const, env };
  const databasePath = path.join(data, 'kiokuko', 'kiokuko.sqlite3');
  async function put(relative: string, value: string | Uint8Array) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value);
    return target;
  }
  return { root, home, data, config, runtime, options, databasePath, put };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else files[path.relative(root, target)] = createHash('sha256').update(await readFile(target)).digest('hex');
    }
  }
  await visit(root);
  return files;
}

function terminal() {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) { this.isRaw = mode; return this; },
  });
  let text = '';
  const output = Object.assign(new Writable({ write(chunk, _encoding, callback) {
    text += chunk.toString();
    callback();
  } }), { isTTY: true, columns: 80, rows: 24 });
  return { input, output, text: () => text };
}

test('uninstall CLI arrows and Space select agents; files change only after Enter', async t => {
  const f = await fixture(t);
  await setupGlobalClients({ ...f.options, clients: [...SETUP_CLIENTS] });
  await f.put('data/kiokuko/models/embeddings/example/model.bin', 'model');
  await f.put('project/AGENTS.md', 'user instructions');
  await useRepository({ root: path.join(f.root, 'project'), allowDirectory: true, databasePath: f.databasePath });
  const before = await snapshot(f.root);
  const io = terminal();
  const run = buildCli({ setupEnvironment: f.options, uninstallInput: io.input, uninstallOutput: io.output })
    .parseAsync(['node', 'kiokuko', 'uninstall']);
  assert.match(io.text(), /> 1\. \[ \] Codex/);
  io.input.write('\x1b[B \x1b[B \x1b[A \x1b[A ');
  // Select Codex and Claude; toggle OpenCode back off.
  assert.match(io.text(), /> 2\. \[ \] OpenCode/);
  assert.match(io.text(), /> 1\. \[x\] Codex/);
  assert.deepEqual(await snapshot(f.root), before);
  io.input.write('\r');
  await run;
  const after = await snapshot(f.root);
  const removedPrefixes = ['home/.codex/', 'home/.agents/skills/', 'home/.claude'];
  assert.deepEqual(after, Object.fromEntries(Object.entries(before).filter(([name]) => !removedPrefixes.some(prefix => name.startsWith(prefix)))));
  assert.match(io.text(), /Shared memory, models and project bindings are retained/);
  assert.doesNotMatch(io.text(), /npm uninstall/);
  assert.equal(io.input.isRaw, false);
  assert.equal(io.input.listenerCount('keypress'), 0);
});

for (const [name, keys] of [['Escape', '\x1b'], ['Ctrl+C', '\x03'], ['Ctrl+D', '\x04'], ['empty Enter', '\r'], ['input end', null]] as const) {
  test(`uninstall CLI ${name} leaves all files unchanged and releases terminal input`, { timeout: 5000 }, async t => {
    const f = await fixture(t);
    await setupGlobalClients({ ...f.options, clients: ['codex'], standardSkills: false });
    const before = await snapshot(f.root);
    const io = terminal();
    const run = buildCli({ setupEnvironment: f.options, uninstallInput: io.input, uninstallOutput: io.output })
      .parseAsync(['node', 'kiokuko', 'uninstall']);
    const done = name === 'empty Enter' ? run : assert.rejects(run, /Uninstall selection cancelled/);
    if (keys === null) io.input.end();
    else io.input.write(keys);
    await done;
    assert.deepEqual(await snapshot(f.root), before);
    assert.doesNotMatch(io.text(), /npm uninstall/);
    assert.equal(io.input.isRaw, false);
    if (!io.input.destroyed) assert.equal(io.input.isPaused(), true);
    for (const event of ['keypress', 'end', 'close', 'error']) assert.equal(io.input.listenerCount(event), 0);
    for (const event of ['resize', 'error']) assert.equal(io.output.listenerCount(event), 0);
  });
}

test('selecting all agents in the terminal removes shared data and prints npm command last', async t => {
  const f = await fixture(t);
  await setupGlobalClients({ ...f.options, clients: [...SETUP_CLIENTS] });
  const io = terminal();
  // Some pseudoterminals report zero dimensions until a window size is supplied.
  io.output.columns = 0;
  io.output.rows = 0;
  const run = buildCli({ setupEnvironment: f.options, uninstallInput: io.input, uninstallOutput: io.output })
    .parseAsync(['node', 'kiokuko', 'uninstall']);
  assert.match(io.text(), /4\. \[ \] Hermes Agent/);
  io.input.write(' \x1b[B \x1b[B \x1b[B \r');
  await run;
  assert.deepEqual(await snapshot(f.root), {});
  assert.ok(io.text().endsWith('npm uninstall --global kiokuko\n'));
});

test('CLI explicit client selection preserves unchecked config, including invalid syntax', async t => {
  const f = await fixture(t);
  await setupGlobalClients({ ...f.options, clients: [...SETUP_CLIENTS] });
  await f.put('config/opencode/opencode.jsonc', '{invalid');
  const before = await snapshot(f.root);
  const io = terminal();
  await buildCli({ setupEnvironment: f.options, uninstallOutput: io.output })
    .parseAsync(['node', 'kiokuko', 'uninstall', '--clients', 'hermes,hermes', '--json']);
  const result = JSON.parse(io.text()).data;
  assert.deepEqual(result.clients, ['hermes']);
  assert.equal(result.scope, 'clients');
  assert.equal(result.npmCommand, null);
  assert.deepEqual(await snapshot(f.root), Object.fromEntries(Object.entries(before).filter(([name]) => !name.startsWith('home/.hermes/'))));
});

test('noninteractive uninstall requires explicit scope and invalid options cannot delete files', async t => {
  const f = await fixture(t);
  await setupGlobalClients({ ...f.options, clients: ['codex'], standardSkills: false });
  const before = await snapshot(f.root);
  for (const args of [[], ['--json'], ['--clients', 'typo'], ['--all', '--clients', 'codex']]) {
    const io = terminal();
    io.input.isTTY = false;
    await assert.rejects(buildCli({ setupEnvironment: f.options, uninstallInput: io.input, uninstallOutput: io.output })
      .parseAsync(['node', 'kiokuko', 'uninstall', ...args]), /terminal|requires --clients|subset|either --all/);
    assert.deepEqual(await snapshot(f.root), before);
  }
  await assert.rejects(uninstallKiokuko({ ...f.options, clients: ['invalid'] as never }), /subset/);
  await assert.rejects(uninstallKiokuko({ ...f.options, clients: null as never }), /subset/);
  const result = await uninstallKiokuko({ ...f.options, clients: [] });
  assert.equal(result.scope, 'none');
  assert.deepEqual(await snapshot(f.root), before);
});

test('selective dry-run plans only selected agents and changes no files', async t => {
  const f = await fixture(t);
  await setupGlobalClients({ ...f.options, clients: [...SETUP_CLIENTS] });
  const before = await snapshot(f.root);
  const io = terminal();
  await buildCli({ setupEnvironment: f.options, uninstallOutput: io.output })
    .parseAsync(['node', 'kiokuko', 'uninstall', '--clients', 'opencode', '--dry-run', '--json']);
  const result = JSON.parse(io.text()).data;
  assert.equal(result.dryRun, true);
  assert.ok(result.files.length > 0);
  assert.ok(result.files.every((file: { path: string }) => file.path.startsWith(path.join(f.config, 'opencode/'))));
  assert.deepEqual(await snapshot(f.root), before);
});

test('setup then uninstall cleans all clients, Hermes profiles, custom project instructions, models and database, preserving user files', async t => {
  const f = await fixture(t);
  await f.put('home/.codex/config.toml', 'model = "keep"\n');
  await f.put('home/.codex/AGENTS.md', 'Keep global instructions.\n');
  await f.put('home/.claude.json', '{"theme":"keep","mcpServers":{"other":{"command":"keep"}}}\n');
  await f.put('config/opencode/opencode.jsonc', '// keep comment\n{"theme":"keep","mcp":{"other":{"type":"remote","url":"https://example.test"}}}\n');
  await f.put('home/.hermes/config.yaml', '# keep comment\nmodel: keep\n');
  await setupGlobalClients({ ...f.options, clients: ['codex', 'opencode', 'claude', 'hermes'] });
  await setupGlobalClients({ ...f.options, env: { ...f.options.env, HERMES_HOME: path.join(f.home, '.hermes/profiles/work') }, clients: ['hermes'] });
  const agentPath = await f.put('project/docs/AI.md', 'Keep project instructions.\n');
  const ignorePath = await f.put('project/.gitignore', 'node_modules/\n');
  await useRepository({ root: path.join(f.root, 'project'), allowDirectory: true, databasePath: f.databasePath, agentFile: 'docs/AI.md', ensureNewBindingIgnored: true });
  const agentBefore = await readFile(agentPath, 'utf8');
  const unmanagedSkill = await f.put('home/.agents/skills/kiokuko-soul/notes.txt', 'user notes');
  const userImage = await f.put('home/.agents/skills/kiokuko-soul/image.png', new Uint8Array([255, 254]));
  await f.put('data/kiokuko/models/embeddings/local-small/revision/model.bin', new Uint8Array([255, 0, 254]));
  const unrelated = await f.put('data/kiokuko/backup-chosen-by-user.sqlite', 'preserve backup');
  const before = await snapshot(f.root);
  const dryRun = await uninstallKiokuko({ ...f.options, dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.ok(dryRun.files.some(file => file.path === agentPath && file.action === 'updated'));
  assert.deepEqual(await snapshot(f.root), before);
  const result = await uninstallKiokuko(f.options);
  assert.equal(result.npmCommand, 'npm uninstall --global kiokuko');
  assert.equal(await readFile(agentPath, 'utf8'), agentBefore.replace(/<!-- BEGIN KIOKUKO MANAGED BLOCK -->[\s\S]*<!-- END KIOKUKO MANAGED BLOCK -->/u, ''));
  assert.equal(await readFile(ignorePath, 'utf8'), 'node_modules/\n');
  assert.equal((await readFile(path.join(f.home, '.codex/config.toml'), 'utf8')).trim(), 'model = "keep"');
  const openCode = await readFile(path.join(f.config, 'opencode/opencode.jsonc'), 'utf8');
  assert.match(openCode, /keep comment/u);
  assert.equal(parse(openCode).mcp.kiokuko, undefined);
  assert.equal(parse(openCode).mcp.other.type, 'remote');
  assert.equal(JSON.parse(await readFile(path.join(f.home, '.claude.json'), 'utf8')).mcpServers.other.command, 'keep');
  assert.match(await readFile(path.join(f.home, '.hermes/config.yaml'), 'utf8'), /# keep comment\nmodel: keep/u);
  assert.equal(await readFile(unmanagedSkill, 'utf8'), 'user notes');
  assert.deepEqual(await readFile(userImage), Buffer.from([255, 254]));
  assert.equal(await readFile(unrelated, 'utf8'), 'preserve backup');
  for (const target of [f.databasePath, `${f.databasePath}-wal`, `${f.databasePath}-shm`, path.join(f.root, 'project/.kiokuko.json'), path.join(f.data, 'kiokuko/models'), path.join(f.home, '.hermes/profiles/work/config.yaml'), path.join(f.runtime, 'kiokuko')]) {
    await assert.rejects(access(target), { code: 'ENOENT' });
  }
  const after = await snapshot(f.root);
  await uninstallKiokuko(f.options);
  assert.deepEqual(await snapshot(f.root), after);
});

test('fresh managed config files and skill directories disappear and CLI prints npm command last', async t => {
  const f = await fixture(t);
  await setupGlobalClients({ ...f.options, clients: ['codex', 'opencode', 'claude', 'hermes'] });
  let output = '';
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write;
  try { await buildCli({ setupEnvironment: f.options }).parseAsync(['node', 'kiokuko', 'uninstall', '--all']); }
  finally { process.stdout.write = write; }
  assert.ok(output.endsWith('npm uninstall --global kiokuko\n'));
  assert.deepEqual(await snapshot(f.root), {});
  assert.match(buildCli().commands.find(command => command.name() === 'uninstall')!.helpInformation(), /--dry-run/u);
});

test('unrecognized MCP entries are preserved across clients while uninstall completes', async t => {
  const f = await fixture(t);
  await setupGlobalClients({ ...f.options, clients: ['codex', 'opencode', 'claude', 'hermes'] });
  const configs = new Map([
    ['home/.codex/config.toml', 'model = "keep"\n[mcp_servers.kiokuko]\nurl = "https://example.test/mcp"\n'],
    ['config/opencode/opencode.jsonc', '// keep\n{"mcp":{"kiokuko":{"type":"remote","url":"https://example.test/mcp"},"other":{"type":"remote"}}}\n'],
    ['home/.claude.json', '{"mcpServers":{"kiokuko":{"command":"user-server"}}}\n'],
    ['home/.hermes/config.yaml', 'mcp_servers:\n  kiokuko:\n    command: user-server\n    args: [custom]\n'],
  ]);
  for (const [target, content] of configs) await f.put(target, content);
  const before = await snapshot(f.root);
  const preview = await uninstallKiokuko({ ...f.options, dryRun: true });
  assert.deepEqual(await snapshot(f.root), before);
  for (const target of configs.keys()) {
    assert.ok(preview.files.some(file => file.path === path.join(f.root, target)
      && file.action === 'preserved' && file.reason?.includes('MCP')));
  }
  let output = '';
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write;
  try { await buildCli({ setupEnvironment: f.options }).parseAsync(['node', 'kiokuko', 'uninstall', '--all']); }
  finally { process.stdout.write = write; }
  assert.match(output, /preserved:.*opencode\.jsonc.*MCP/u);
  assert.ok(output.endsWith('npm uninstall --global kiokuko\n'));
  for (const [target, content] of configs) assert.equal(await readFile(path.join(f.root, target), 'utf8'), content);
  await assert.rejects(access(f.databasePath), { code: 'ENOENT' });
  await assert.rejects(access(path.join(f.home, '.codex/AGENTS.md')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(f.home, '.agents/skills/kiokuko-soul')), { code: 'ENOENT' });
  // opencode.json was recognized and removed independently of the unknown JSONC entry.
  await assert.rejects(access(path.join(f.config, 'opencode/opencode.json')), { code: 'ENOENT' });
});

test('malformed instructions and invalid MCP JSON still reject the plan without deleting data', async t => {
  const f = await fixture(t);
  await setupGlobalClients({ ...f.options, clients: ['codex'] });
  const invalidConfig = await f.put('config/opencode/opencode.jsonc', '{"mcp": {');
  let before = await snapshot(f.root);
  await assert.rejects(uninstallKiokuko(f.options), { code: 'VALIDATION_ERROR' });
  assert.deepEqual(await snapshot(f.root), before);
  await rm(invalidConfig);
  await f.put('home/.codex/AGENTS.md', '<!-- BEGIN KIOKUKO GLOBAL MEMORY -->\nmissing end');
  before = await snapshot(f.root);
  await assert.rejects(uninstallKiokuko(f.options), { code: 'VALIDATION_ERROR' });
  assert.deepEqual(await snapshot(f.root), before);
});

test('a file changed after planning is preserved and no other cleanup starts', async t => {
  const f = await fixture(t);
  await setupGlobalClients({ ...f.options, clients: ['codex'] });
  const instructions = path.join(f.home, '.codex/AGENTS.md');
  const original = await readFile(instructions, 'utf8');
  await assert.rejects(uninstallKiokuko(f.options, {
    beforeCommit: () => f.put('home/.codex/config.toml', 'model = "changed concurrently"\n').then(() => undefined),
  }), { code: 'CONFLICT' });
  assert.equal(await readFile(instructions, 'utf8'), original);
  await access(f.databasePath);
});

test('partial failure keeps the database and custom binding for a successful retry', async t => {
  const f = await fixture(t);
  await setupGlobalClients({ ...f.options, clients: [] });
  const agent = await f.put('project/docs/custom.md', 'keep');
  await useRepository({ root: path.join(f.root, 'project'), databasePath: f.databasePath, allowDirectory: true, agentFile: 'docs/custom.md' });
  await assert.rejects(uninstallKiokuko(f.options, {
    applyTextRemoval: file => file.path === agent ? Promise.reject(new Error('injected write failure')) : applyTextRemoval(file),
  }), (error: unknown) => error instanceof KiokukoError && error.code === 'PARTIAL_FAILURE' && error.message.includes('injected write failure'));
  await access(f.databasePath);
  await access(path.join(f.root, 'project/.kiokuko.json'));
  await uninstallKiokuko(f.options);
  assert.equal((await readFile(agent, 'utf8')).trim(), 'keep');
});

test('live instance lock rejects cleanup even when server.json is absent', async t => {
  const f = await fixture(t);
  await setupGlobalClients({ ...f.options, clients: [] });
  const lock = getDatabaseLockPath(f.databasePath, f.options);
  await mkdir(path.dirname(lock), { recursive: true });
  await writeFile(lock, JSON.stringify({ instanceId: 'live', pid: process.pid }), { mode: 0o600 });
  const before = await snapshot(f.root);
  await assert.rejects(uninstallKiokuko(f.options), { code: 'CONFLICT' });
  assert.deepEqual(await snapshot(f.root), before);
});

test('linked skill subdirectories are never followed', async t => {
  const f = await fixture(t);
  await setupGlobalClients({ ...f.options, clients: ['codex'] });
  const target = await f.put('outside/private.txt', 'keep');
  await symlink(path.dirname(target), path.join(f.home, '.agents/skills/kiokuko-soul/linked'));
  await assert.rejects(uninstallKiokuko(f.options), { code: 'SECURITY_REJECTION' });
  assert.equal(await readFile(target, 'utf8'), 'keep');
  await access(f.databasePath);
});

test('retired hooks, plugins and Skills are removed without deleting adjacent hooks', async t => {
  const f = await fixture(t);
  const source = JSON.stringify({ hooks: { Stop: [{ hooks: [
    { type: 'command', command: '/opt/bin/kiokuko enno hook --client codex --input-json -' },
    { type: 'command', command: 'user-hook' },
  ] }] }, enabled: true });
  await f.put('home/.codex/hooks.json', source);
  await f.put('config/opencode/plugins/kiokuko-enno-oduno.js', '// Managed by `kiokuko setup`: Enno-Oduno v1\nexport default {};\n');
  await f.put('home/.agents/skills/kiokuko-enno-oduno/SKILL.md', '<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-enno-oduno -->\nold');
  await uninstallKiokuko(f.options);
  const hooks = JSON.parse(await readFile(path.join(f.home, '.codex/hooks.json'), 'utf8'));
  assert.deepEqual(hooks.hooks.Stop[0].hooks, [{ type: 'command', command: 'user-hook' }]);
  assert.equal(hooks.enabled, true);
  await assert.rejects(access(path.join(f.config, 'opencode/plugins/kiokuko-enno-oduno.js')));
  await assert.rejects(access(path.join(f.home, '.agents/skills/kiokuko-enno-oduno')));
  assert.equal(removeLegacyHooks('{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"mcp_tool","server":"kiokuko","tool":"claude_prompt_context"}]}]}}', 'claude'), undefined);
});

test('JSON dry-run works without an installed database and creates no target files', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.root);
  let output = '';
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { output += chunk.toString(); return true; }) as typeof process.stdout.write;
  try { await buildCli({ setupEnvironment: f.options }).parseAsync(['node', 'kiokuko', 'uninstall', '--dry-run', '--json']); }
  finally { process.stdout.write = write; }
  const result = JSON.parse(output);
  assert.equal(result.ok, true);
  assert.equal(result.data.dryRun, true);
  assert.equal(result.data.npmCommand, 'npm uninstall --global kiokuko');
  assert.deepEqual(result.data.files, []);
  await uninstallKiokuko(f.options);
  assert.deepEqual(await snapshot(f.root), before);
});

test('a shared custom data directory retains unrelated files and an embedding lock prevents cleanup', async t => {
  const f = await fixture(t);
  const options = { ...f.options, env: { ...f.options.env, KIOKUKO_DATA_DIR: f.home } };
  await setupGlobalClients({ ...options, clients: [] });
  const keep = await f.put('home/personal.txt', 'keep');
  const lock = await f.put('home/models/embeddings/.setup.lock', 'pending-setup');
  const before = await snapshot(f.root);
  await assert.rejects(uninstallKiokuko(options), { code: 'CONFLICT' });
  assert.deepEqual(await snapshot(f.root), before);
  await rm(lock);
  await uninstallKiokuko(options);
  assert.equal(await readFile(keep, 'utf8'), 'keep');
  await assert.rejects(access(path.join(f.home, 'kiokuko.sqlite3')), { code: 'ENOENT' });
});

test('uninstall recognizes disabled setup MCP entries with user-supplied environment overrides', async t => {
  const f = await fixture(t);
  await setupGlobalClients({ ...f.options, clients: ['opencode', 'claude'], standardSkills: false });
  const openCodePath = path.join(f.config, 'opencode/opencode.json');
  const config = JSON.parse(await readFile(openCodePath, 'utf8'));
  config.mcp.kiokuko.enabled = false;
  config.mcp.kiokuko.environment.KIOKUKO_DATA_DIR = path.dirname(f.databasePath);
  config.theme = 'keep';
  await writeFile(openCodePath, JSON.stringify(config));
  const claudePath = path.join(f.home, '.claude.json');
  const claude = JSON.parse(await readFile(claudePath, 'utf8'));
  claude.mcpServers.kiokuko.env.KIOKUKO_DATA_DIR = path.dirname(f.databasePath);
  claude.theme = 'keep';
  await writeFile(claudePath, JSON.stringify(claude));
  await uninstallKiokuko(f.options);
  assert.equal(JSON.parse(await readFile(openCodePath, 'utf8')).mcp, undefined);
  assert.equal(JSON.parse(await readFile(claudePath, 'utf8')).mcpServers, undefined);
  assert.equal(JSON.parse(await readFile(openCodePath, 'utf8')).theme, 'keep');
  assert.equal(JSON.parse(await readFile(claudePath, 'utf8')).theme, 'keep');
});

test('cleanup reports both the original failure and lost lock ownership without hiding either', async t => {
  const f = await fixture(t);
  await setupGlobalClients({ ...f.options, clients: ['codex'], standardSkills: false });
  await assert.rejects(uninstallKiokuko(f.options, {
    applyTextRemoval: async () => {
      await rm(getDatabaseLockPath(f.databasePath, f.options));
      throw new Error('primary cleanup failure');
    },
  }), (error: unknown) => error instanceof KiokukoError && error.code === 'PARTIAL_FAILURE'
    && error.message.includes('primary cleanup failure') && error.message.includes('lock'));
  await access(f.databasePath);
});
