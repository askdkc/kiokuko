import assert from 'node:assert/strict';
import test from 'node:test';
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
