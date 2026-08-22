import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { buildCli } from '../../src/cli.js';
import { promptSetupClients } from '../../src/commands/setup.js';

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

test('plans Hermes-only setup when Hermes Agent is detected and no client is selected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-cli-hermes-'));
  const hermesHome = path.join(root, '.hermes');
  const bin = path.join(root, 'bin');
  await mkdir(hermesHome, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(hermesHome, 'active_profile'), 'default\n');
  const hermes = path.join(bin, 'hermes');
  await writeFile(hermes, '#!/bin/sh\n');
  await chmod(hermes, 0o755);

  let stdout = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({ setupEnvironment: { platform: 'linux', env: { HOME: root, PATH: bin } } })
      .parseAsync(['node', 'kiokuko', 'setup', '--dry-run', '--json']);
  } finally {
    process.stdout.write = originalWrite;
  }

  const response = JSON.parse(stdout) as {
    data: {
      clients: string[];
      databaseAction: string;
      databasePath: string;
      dryRun: boolean;
      files: Array<{ client: string; path: string }>;
    };
    ok: boolean;
  };
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.clients, ['hermes']);
  assert.equal(response.data.databaseAction, 'planned');
  assert.equal(response.data.dryRun, true);
  assert.ok(response.data.files.every((file) => file.client === 'hermes'));
  for (const file of response.data.files) await assert.rejects(access(file.path));
  await assert.rejects(access(response.data.databasePath));
});

test('no-argument setup does not configure clients when no client executable is detected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-cli-no-hermes-'));
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
      .parseAsync(['node', 'kiokuko', 'setup', '--dry-run', '--json']);
  } finally {
    process.stdout.write = originalWrite;
  }

  const response = JSON.parse(stdout) as { data: { clients: string[]; files: unknown[] }; ok: boolean };
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.clients, []);
  assert.deepEqual(response.data.files, []);
});

test('no-argument setup configures only client executables detected on PATH', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-cli-detected-clients-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  for (const client of ['codex', 'claude']) {
    const executable = path.join(bin, client);
    await writeFile(executable, '#!/bin/sh\n');
    await chmod(executable, 0o755);
  }

  let stdout = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({ setupEnvironment: { platform: 'linux', env: { HOME: root, PATH: bin } } })
      .parseAsync(['node', 'kiokuko', 'setup', '--dry-run', '--json']);
  } finally {
    process.stdout.write = originalWrite;
  }

  const response = JSON.parse(stdout) as { data: { clients: string[]; files: Array<{ client: string }> }; ok: boolean };
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.clients, ['codex', 'claude']);
  assert.ok(response.data.files.every((file) => ['codex', 'claude'].includes(file.client)));
});

test('setup prompt preselects detected clients and accepts names or numbers', async () => {
  let outputText = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputText += chunk.toString();
      callback();
    },
  });
  const selected = await promptSetupClients(['codex', 'claude'], {
    input: Readable.from(['2,4\n']),
    output,
  });

  assert.deepEqual(selected, ['opencode', 'hermes']);
  assert.match(outputText, /1\. \[x\] Codex \(detected\)/);
  assert.match(outputText, /2\. \[ \] OpenCode \(not detected\)/);
  assert.match(outputText, /3\. \[x\] Claude Code \(detected\)/);
});

test('setup prompt accepts the detected selection on an empty answer', async () => {
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const selected = await promptSetupClients(['hermes'], { input: Readable.from(['\n']), output });
  assert.deepEqual(selected, ['hermes']);
});

test('interactive setup applies the selection returned by the prompt', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-cli-interactive-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const codex = path.join(bin, 'codex');
  await writeFile(codex, '#!/bin/sh\n');
  await chmod(codex, 0o755);

  const input = Readable.from(['4\n']) as Readable & { isTTY?: boolean };
  input.isTTY = true;
  let promptOutput = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      promptOutput += chunk.toString();
      callback();
    },
  }) as Writable & { isTTY?: boolean };
  output.isTTY = true;
  let stdout = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({
      setupEnvironment: { platform: 'linux', env: { HOME: root, PATH: bin } },
      setupInput: input,
      setupOutput: output,
    }).parseAsync(['node', 'kiokuko', 'setup', '--dry-run']);
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.match(promptOutput, /1\. \[x\] Codex \(detected\)/);
  assert.match(stdout, /Kiokuko setup plan for hermes:/);
});

test('explicit client selection takes precedence over Hermes detection', async () => {
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
      .parseAsync(['node', 'kiokuko', 'setup', '--clients', 'codex', '--dry-run', '--json']);
  } finally {
    process.stdout.write = originalWrite;
  }

  const response = JSON.parse(stdout) as { data: { clients: string[] }; ok: boolean };
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.clients, ['codex']);
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
