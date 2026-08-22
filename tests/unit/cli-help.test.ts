import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCli } from '../../src/cli.js';

test('reports the package version instead of a stale hard-coded CLI version', () => {
  const packageMetadata = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(buildCli().version(), packageMetadata.version);
});

test('prints the package version from the version subcommand', async () => {
  const packageMetadata = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  let stdout = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli().parseAsync(['node', 'kiokuko', 'version']);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(stdout, `${packageMetadata.version}\n`);
});

test('registers required commands', () => {
  const names = buildCli().commands.map((command) => command.name());
  for (const name of [
    'version',
    'init',
    'setup',
    'mcp',
    'use',
    'recall',
    'search',
    'read',
    'record',
    'promote',
    'curator',
    'supersede',
    'link',
    'export',
    'import',
    'backup',
    'purge',
    'doctor',
    'web',
    'guide',
    'call',
    'agent',
  ]) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
});

test('exposes the curator review and confirmation options', () => {
  const curator = buildCli().commands.find((command) => command.name() === 'curator');
  assert.ok(curator);
  const help = curator.helpInformation();
  assert.match(help, /--workspace <name>/);
  assert.match(help, /--entry-id <id>/);
  assert.match(help, /--skill-ready-only/);
  assert.match(help, /--yes/);
  assert.match(help, /--json/);
});

test('exposes the Akinator guide subcommands', () => {
  const guide = buildCli().commands.find((command) => command.name() === 'guide');
  assert.ok(guide);
  assert.deepEqual(guide.commands.map((command) => command.name()), ['start', 'answer', 'context']);
  assert.match(guide.commands.find((command) => command.name() === 'context')?.helpInformation() ?? '', /--no-client-skills/);
});

test('exposes the generic agent lifecycle subcommands and required options', () => {
  const agent = buildCli().commands.find((command) => command.name() === 'agent');
  assert.ok(agent);
  assert.deepEqual(agent.commands.map((command) => command.name()), ['open', 'answer', 'events', 'checkpoint', 'close', 'feedback']);
  assert.match(agent.commands.find((command) => command.name() === 'open')?.helpInformation() ?? '', /--workspace <workspace>/);
  assert.match(agent.commands.find((command) => command.name() === 'open')?.helpInformation() ?? '', /--client <kind>/);
  assert.match(agent.commands.find((command) => command.name() === 'open')?.helpInformation() ?? '', /--task <task>/);
  assert.match(agent.commands.find((command) => command.name() === 'answer')?.helpInformation() ?? '', /--question-id <id>/);
  assert.match(agent.commands.find((command) => command.name() === 'events')?.helpInformation() ?? '', /--input-json <file\|->/);
});
test('exposes help for the use command', () => {
  const use = buildCli().commands.find((command) => command.name() === 'use');
  assert.ok(use);
  assert.match(use.helpInformation(), /--root/);
  assert.match(use.helpInformation(), /--workspace/);
  assert.match(use.helpInformation(), /--dry-run/);
});

test('exposes Claude Code as a global setup client', () => {
  const setup = buildCli().commands.find((command) => command.name() === 'setup');
  assert.ok(setup);
  assert.match(setup.helpInformation(), /codex,opencode,claude,hermes/);
  assert.match(setup.description(), /Claude Code/);
  assert.match(setup.description(), /Hermes Agent/);
  assert.match(setup.helpInformation(), /--no-standard-skills/);
});

test('recommends Hermes-only setup when Hermes Agent is detected and no client is selected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-cli-hermes-'));
  const hermesHome = path.join(root, '.hermes');
  await mkdir(hermesHome, { recursive: true });
  await writeFile(path.join(hermesHome, 'config.yaml'), 'mcp_servers: {}\n');

  let stdout = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({ setupEnvironment: { platform: 'linux', env: { HOME: root, PATH: '' } } })
      .parseAsync(['node', 'kiokuko', 'setup']);
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(stdout, 'Hermes Agent detected. Run `kiokuko setup --clients hermes` to configure Kiokuko for Hermes Agent.\n');
});

test('explicit client selection bypasses Hermes setup guidance', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-cli-hermes-explicit-'));
  const hermesHome = path.join(root, '.hermes');
  await mkdir(hermesHome, { recursive: true });
  await writeFile(path.join(hermesHome, 'config.yaml'), 'mcp_servers: {}\n');

  let stdout = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({ setupEnvironment: { platform: 'linux', env: { HOME: root, PATH: '' } } })
      .parseAsync(['node', 'kiokuko', 'setup', '--clients', 'hermes', '--dry-run', '--json']);
  } finally {
    process.stdout.write = originalWrite;
  }

  const response = JSON.parse(stdout) as { data: { clients: string[] }; ok: boolean };
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.clients, ['hermes']);
});

test('exposes foreground serve options without capability-token controls', () => {
  const serve = buildCli().commands.find((command) => command.name() === 'serve');
  assert.ok(serve);
  const help = serve.helpInformation();
  assert.match(help, /--host <host>/);
  assert.match(help, /--port <number>/);
  assert.match(help, /--json/);
  assert.doesNotMatch(help, /token|database|lock/i);
});

test('exposes exactly server status in the server command group', () => {
  const server = buildCli().commands.find((command) => command.name() === 'server');
  assert.ok(server);
  assert.deepEqual(server.commands.map((command) => command.name()), ['status']);
  const status = server.commands[0];
  assert.ok(status);
  assert.match(status.helpInformation(), /--json/);
});
