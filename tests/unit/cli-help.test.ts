import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCli } from '../../src/cli.js';

test('registers required commands', () => {
  const names = buildCli().commands.map((command) => command.name());
  for (const name of [
    'init',
    'use',
    'recall',
    'search',
    'read',
    'record',
    'promote',
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

test('exposes the Akinator guide subcommands', () => {
  const guide = buildCli().commands.find((command) => command.name() === 'guide');
  assert.ok(guide);
  assert.deepEqual(guide.commands.map((command) => command.name()), ['start', 'answer', 'context']);
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
