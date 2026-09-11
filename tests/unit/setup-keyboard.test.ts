import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { promptReplaceConflictingMcp, promptSetupClients, promptSetupConfiguration, runSetupFlow } from '../../src/commands/setup.js';

function terminal(onOutput?: (text: string) => void) {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) { this.isRaw = mode; return this; },
  });
  let text = '';
  const output = Object.assign(new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      onOutput?.(chunk.toString());
      callback();
    },
  }), { isTTY: true, columns: 80, rows: 24 });
  return { input, output, text: () => text };
}

function assertReleased(io: ReturnType<typeof terminal>, wasRaw = false) {
  assert.equal(io.input.isRaw, wasRaw);
  if (!io.input.destroyed) assert.equal(io.input.isPaused(), true);
  for (const event of ['keypress', 'end', 'close', 'error']) {
    assert.equal(io.input.listenerCount(event), 0, `input ${event} listener leaked`);
  }
  assert.equal(io.output.listenerCount('resize'), 0);
  assert.equal(io.output.listenerCount('error'), 0);
}

test('terminal arrows move focus, Space toggles clients, and only Enter confirms', async () => {
  const io = terminal();
  const detected = ['codex', 'claude'] as const;
  const selected = promptSetupClients([...detected], io);
  let confirmed = false;
  void selected.then(() => { confirmed = true; });
  assert.match(io.text(), /> 1\. \[x\] Codex \(detected\)/);
  io.input.write('\x1b[B');
  assert.match(io.text(), /> 2\. \[ \] OpenCode/);
  io.input.write(' \x1b[B ');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(confirmed, false);
  io.input.write('\r');
  assert.deepEqual(await selected, ['codex', 'opencode']);
  assert.deepEqual(detected, ['codex', 'claude']);
  assert.match(io.text(), /> 3\. \[ \] Claude Code/);
  assertReleased(io);
});

test('terminal number keys toggle multiple clients and arrows wrap at both ends', async () => {
  const io = terminal();
  const selected = promptSetupClients([], io);
  io.input.write('\x1b[A ');
  assert.match(io.text(), /> 4\. \[x\] Hermes Agent/);
  io.input.write('\x1b[B ');
  assert.match(io.text(), /> 1\. \[x\] Codex/);
  io.input.write('134\r');
  assert.deepEqual(await selected, ['claude']);
  assertReleased(io);
});

test('terminal Enter accepts detected clients and number keys can deselect every client', async () => {
  for (const [keys, expected] of [['\r', ['hermes']], ['4\r', []]] as const) {
    const io = terminal();
    io.input.isRaw = true;
    const selected = promptSetupClients(['hermes'], io);
    io.input.write(keys);
    assert.deepEqual(await selected, expected);
    assertReleased(io, true);
  }
});

for (const [label, keys] of [['Escape', '\x1b'], ['Ctrl+C', '\x03'], ['Ctrl+D', '\x04']] as const) {
  test(`terminal ${label} cancels without running setup and restores input`, { timeout: 3000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-keyboard-cancel-'));
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    let called = false;
    let sent = false;
    const io = terminal((text) => {
      if (!sent && text.includes('Enter: confirm')) {
        sent = true;
        setImmediate(() => io.input.write(keys));
      }
    });
    await assert.rejects(runSetupFlow({
      ...io,
      environment: { platform: 'linux', env: { HOME: root, PATH: bin } },
    }, { setupGlobalClients: async (options) => {
      called = true;
      return { clients: options.clients ?? [], projectAgentFiles: [] };
    } }), /Setup selection cancelled/);
    assert.equal(called, false);
    assertReleased(io);
  });
}

test('terminal input ending or failing rejects instead of accepting an unfinished selection', async () => {
  for (const failure of ['end', 'error'] as const) {
    const io = terminal();
    const selected = promptSetupClients(['codex'], io);
    const rejected = assert.rejects(selected, failure === 'end' ? /cancelled/ : /input failed/);
    if (failure === 'end') io.input.end();
    else io.input.emit('error', new Error('input failed'));
    await rejected;
    assertReleased(io);
  }
});

test('terminal selection hands input to the following discovery and conflict line prompts', async () => {
  const io = terminal((text) => {
    if (text.includes('Enable community Skill discovery?')) {
      setImmediate(() => io.input.write('yes\r'));
    }
    if (text.includes('Replace the existing Hermes Agent')) {
      setImmediate(() => io.input.write('n\r'));
    }
  });
  const selected = promptSetupConfiguration(['codex'], io);
  io.input.write('14\r');
  assert.deepEqual(await selected, { clients: ['hermes'], skillDiscoveryMode: 'community' });
  assert.equal(await promptReplaceConflictingMcp('hermes', io), false);
  assert.equal(io.input.isRaw, false);
  assert.equal(io.input.isPaused(), true);
});

test('terminal empty selection skips the discovery prompt', async () => {
  const io = terminal();
  const selected = promptSetupConfiguration([], io);
  io.input.write('\r');
  assert.deepEqual(await selected, { clients: [], skillDiscoveryMode: 'official' });
  assert.doesNotMatch(io.text(), /Enable community/);
  assertReleased(io);
});

test('terminal narrow rows do not wrap and the focused client stays visible in a short viewport', async () => {
  const io = terminal();
  io.output.columns = 24;
  io.output.rows = 3;
  const selected = promptSetupClients([], io);
  io.input.write('4');
  const screen = io.text().split('\x1b[0J').at(-1)!;
  assert.match(screen, /> 4\. \[x\] Hermes Agent/);
  assert.ok(screen.trimEnd().split('\n').every((line) => line.length < 24));
  io.output.emit('resize');
  io.input.write('\r');
  assert.deepEqual(await selected, ['hermes']);
  assertReleased(io);
});
