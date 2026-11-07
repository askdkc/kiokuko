import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderCodexAssuranceHooks, removeCodexAssuranceHooks, codexAssuranceConfigured } from '../../src/setup/codex-hooks.js';
test('an existing three-second Interrupt does not revert on regeneration', () => {
  const config = JSON.parse(renderCodexAssuranceHooks('', 'kiokuko', '/tmp/db'));
  config.hooks.Interrupt[0].hooks[0].timeout = 3;
  const result = JSON.parse(renderCodexAssuranceHooks(JSON.stringify(config), 'kiokuko', '/tmp/db'));
  assert.equal(result.hooks.Interrupt[0].hooks[0].timeout, 3);
});
test('regeneration preserves event timeouts and migrates Interrupt to the host limit', () => {
  const original = JSON.parse(renderCodexAssuranceHooks('', 'kiokuko', '/tmp/db'));
  assert.equal(original.hooks.Interrupt[0].hooks[0].timeout, 3);
  for (const [event, groups] of Object.entries(original.hooks)) {
    if (event !== 'Interrupt') assert.equal((groups as Array<{ hooks: Array<{ timeout: number }> }>)[0]!.hooks[0]!.timeout, 30);
  }
  for (const timeout of [undefined, 1, 2, 3, 30]) {
    const config = structuredClone(original);
    config.hooks.Interrupt[0].hooks[0].timeout = timeout;
    config.hooks.Stop[0].hooks[0].timeout = 47;
    config.hooks.Stop[0].matcher = 'preserved-matcher';
    config.hooks.Stop[0].hooks[0].async = true;
    delete config.hooks.PreToolUse[0].hooks[0].timeout;
    const userGroup = { matcher: 'user', hooks: [{ type: 'command', command: 'user-hook', timeout: 91 }] };
    config.hooks.Interrupt.unshift(userGroup);
    config.description = 'keep';
    const rendered = renderCodexAssuranceHooks(JSON.stringify(config), 'new-kiokuko', '/tmp/new-db');
    const result = JSON.parse(rendered);
    assert.equal(result.hooks.Interrupt[1].hooks[0].timeout, timeout === undefined ? 3 : Math.min(timeout, 3));
    assert.equal(result.hooks.Stop[0].hooks[0].timeout, 47);
    assert.equal(result.hooks.Stop[0].matcher, 'preserved-matcher');
    assert.equal(result.hooks.Stop[0].hooks[0].async, true);
    assert.equal(Object.hasOwn(result.hooks.PreToolUse[0].hooks[0], 'timeout'), false);
    assert.deepEqual(result.hooks.Interrupt[0], userGroup);
    assert.equal(result.description, 'keep');
    assert.match(result.hooks.Interrupt[1].hooks[0].command, /new-kiokuko/);
    assert.equal(renderCodexAssuranceHooks(rendered, 'new-kiokuko', '/tmp/new-db'), rendered);
  }
});
test('invalid and conflicting managed timeouts are rejected without exposing commands', () => {
  for (const event of ['Interrupt', 'Stop']) {
    for (const timeout of [null, 0, -1, 1.5, '3', true, {}, []]) {
      const config = JSON.parse(renderCodexAssuranceHooks('', 'kiokuko', '/tmp/db'));
      config.hooks[event][0].hooks[0].timeout = timeout;
      assert.throws(() => renderCodexAssuranceHooks(JSON.stringify(config), 'kiokuko', '/tmp/db'), /timeout/i);
    }
    const config = JSON.parse(renderCodexAssuranceHooks('', 'kiokuko', '/tmp/db'));
    const duplicate = structuredClone(config.hooks[event][0]);
    duplicate.hooks[0].timeout = 2;
    config.hooks[event].push(duplicate);
    assert.throws(() => renderCodexAssuranceHooks(JSON.stringify(config), 'kiokuko', '/tmp/db'), /conflicting.*timeout/i);
  }
});
test('Codex setup is idempotent and uninstall preserves unrelated handlers and settings', () => {
  const user = { description: 'user-owned', hooks: { Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: 'user-hook' }] }] } };
  const rendered = renderCodexAssuranceHooks(JSON.stringify(user), '/space dir/kiokuko', '/tmp/db');
  assert.equal(codexAssuranceConfigured(rendered), true);
  assert.equal(renderCodexAssuranceHooks(rendered, '/space dir/kiokuko', '/tmp/db'), rendered);
  assert.deepEqual(JSON.parse(removeCodexAssuranceHooks(rendered)!), user);
  assert.equal(removeCodexAssuranceHooks(renderCodexAssuranceHooks('', 'kiokuko', '/tmp/db')), undefined);
  assert.throws(() => renderCodexAssuranceHooks('{"hooks":{},"hooks":{}}', 'kiokuko', '/tmp/db'), /invalid/);
});
test('pinned Node and CLI launch without PATH and preserve shell argument boundaries', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kiokuko hook-'));
  try {
    const script = path.join(root, "hook's entry.cjs");
    writeFileSync(script, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o755 });
    const database = path.join(root, "db'$(touch NEVER_CREATED).sqlite3");
    const environment = { PATH: '/usr/bin:/bin' };
    const legacy = spawnSync('/bin/sh', ['-c', "'kiokuko' codex-hook --database '/tmp/db'"], { env: environment, encoding: 'utf8' });
    assert.equal(legacy.status, 127);
    const shebang = spawnSync('/bin/sh', ['-c', JSON.parse(renderCodexAssuranceHooks('', script, database)).hooks.PreToolUse[0].hooks[0].command],
      { env: environment, encoding: 'utf8' });
    if (shebang.status !== 0) assert.equal(shebang.status, 127);
    const runtime = { node: process.execPath, script };
    const rendered = renderCodexAssuranceHooks('', 'kiokuko', database, runtime);
    const result = spawnSync('/bin/sh', ['-c', JSON.parse(rendered).hooks.PreToolUse[0].hooks[0].command], { cwd: root, env: environment, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['codex-hook', '--database', database]);
    assert.equal(existsSync(path.join(root, 'NEVER_CREATED')), false);
    assert.equal(renderCodexAssuranceHooks(rendered, 'kiokuko', database, runtime), rendered);
    assert.equal(removeCodexAssuranceHooks(rendered), undefined);
    assert.throws(() => renderCodexAssuranceHooks('', 'kiokuko', database, { ...runtime, node: '\0' }), /NUL/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
