import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { managedAgenticReplay } from './agenticreplay-dependency.mjs';

function fixture(t, { spec = 'latest', lockSpec = spec, locked = '0.1.12', installed = locked, binary = true, section = 'dependencies' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'agenticreplay-dependency-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'node_modules/agenticreplay');
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ [section]: { agenticreplay: spec } }));
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {
    '': { [section]: { agenticreplay: lockSpec } },
    'node_modules/agenticreplay': { version: locked },
  } }));
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'agenticreplay', version: installed }));
  if (binary) writeFileSync(path.join(root, 'node_modules/.bin', process.platform === 'win32' ? 'agenticreplay.cmd' : 'agenticreplay'), 'fixture');
  return root;
}

test('latest is a runtime dependency and verification accepts different lockfile resolutions', t => {
  for (const locked of ['0.1.12', '1.0.0']) {
    for (const lockSpec of ['latest', '*']) {
      assert.equal(managedAgenticReplay(fixture(t, { locked, lockSpec })).version, locked);
    }
  }
});

test('an invalid resolution, stale lock, missing executable, or mismatched installation fails', t => {
  for (const options of [{ locked: 'invalid' }, { lockSpec: '*', locked: 'invalid' },
    { lockSpec: '0.1.12' }, { lockSpec: '^0.1.12' }, { lockSpec: 'next' },
    { installed: '0.1.13' }, { lockSpec: '*', installed: '0.1.13' },
    { binary: false }, { lockSpec: '*', binary: false }]) {
    assert.throws(() => managedAgenticReplay(fixture(t, options)));
  }
});

test('a pinned declaration or a development-only dependency does not satisfy the install contract', t => {
  assert.throws(() => managedAgenticReplay(fixture(t, { spec: '0.1.12' })));
  assert.throws(() => managedAgenticReplay(fixture(t, { section: 'devDependencies' })));
});

