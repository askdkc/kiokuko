import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const recorder = process.env.AGENTICREPLAY_BIN ?? path.join(root, 'node_modules/.bin/agenticreplay');
const shims = mkdtempSync(path.join(tmpdir(), 'kiokuko-recorder-versions-'));

function run(mode) {
  const shim = path.join(shims, `${mode}.mjs`);
  writeFileSync(shim, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('0.1.7'); process.exit(0); }
if (${JSON.stringify(mode)} === 'missing' && args[0] === 'record') {
  console.error('required recording behavior missing'); process.exit(77);
}
const child = spawnSync(${JSON.stringify(recorder)}, args, { env: process.env, stdio: 'inherit' });
if (child.error) throw child.error;
process.exit(child.status ?? 1);
`);
  chmodSync(shim, 0o700);
  const env = { ...process.env, AGENTICREPLAY_BIN: shim };
  for (const key of ['KIOKUKO_VERIFY_COMPLETION_FILE', 'KIOKUKO_VERIFY_NONCE', 'KIOKUKO_VERIFY_CHECK_ID']) delete env[key];
  const result = spawnSync(process.execPath, ['tests/ci/agenticreplay-smoke.mjs'], {
    cwd: root, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000,
  });
  assert.equal(result.error, undefined);
  return result;
}

try {
  const compatible = run('compatible');
  assert.equal(compatible.status, 0, compatible.stderr);
  assert.match(compatible.stdout, /2 recorded responses replayed offline/u);
  const missing = run('missing');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /required recording behavior missing/u);
  assert.doesNotMatch(missing.stderr, /does not satisfy/u);
  console.log('Compatible version-only update passes; missing recording behavior fails.');
} finally {
  rmSync(shims, { recursive: true, force: true });
}
