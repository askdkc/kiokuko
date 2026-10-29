import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { managedAgenticReplay } from './agenticreplay-dependency.mjs';

function fixture(t, { range = '>=0.1.6', locked = '0.1.7', installed = locked, binary = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'agenticreplay-dependency-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'node_modules/agenticreplay');
  mkdirSync(packageRoot, { recursive: true });
  mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { agenticreplay: range } }));
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {
    '': { devDependencies: { agenticreplay: range } },
    'node_modules/agenticreplay': { version: locked },
  } }));
  writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'agenticreplay', version: installed }));
  if (binary) writeFileSync(path.join(root, 'node_modules/.bin', process.platform === 'win32' ? 'agenticreplay.cmd' : 'agenticreplay'), 'fixture');
  return root;
}

test('a compatible newly resolved AgenticReplay release passes without changing verification rules', t => {
  const resolved = managedAgenticReplay(fixture(t));
  assert.equal(resolved.version, '0.1.7');
  assert.equal(resolved.range, '>=0.1.6');
});

test('an incompatible release, missing executable, or mismatched lock and installation fails', t => {
  for (const options of [{ locked: '0.1.5' }, { installed: '0.1.8' }, { binary: false }]) {
    assert.throws(() => managedAgenticReplay(fixture(t, options)));
  }
});

test('an exact version declaration does not replace a compatibility range', t => {
  assert.throws(() => managedAgenticReplay(fixture(t, { range: '0.1.6', locked: '0.1.6' })));
});

