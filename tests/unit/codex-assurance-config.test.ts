import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderCodexAssuranceHooks, removeCodexAssuranceHooks, codexAssuranceConfigured } from '../../src/setup/codex-hooks.js';
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
