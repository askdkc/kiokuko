import assert from 'node:assert/strict';
import test from 'node:test';
import { optionalRuntimeInstallInvocation } from '../../src/commands/embeddings.js';

test('optional runtime installation uses npm directly on macOS', () => {
  const invocation = optionalRuntimeInstallInvocation('darwin');
  assert.equal(invocation.command, 'npm');
  assert.equal(invocation.args[0], 'install');
  assert.equal(invocation.args.includes('--global'), true);
  assert.equal(invocation.args.includes('@askdkc/kiokuko'), false);
  assert.equal(invocation.args.includes('sudo'), false);
});

test('optional runtime installation uses the sudo wrapper only on Linux', () => {
  const invocation = optionalRuntimeInstallInvocation('linux');
  assert.equal(invocation.command, 'sudo');
  assert.equal(invocation.args[0], 'npm');
  assert.equal(invocation.args[1], 'install');
});
