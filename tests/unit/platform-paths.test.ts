import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { getDatabaseLockPath, getGlobalDatabasePath, getRuntimeDescriptorPath, getRuntimeDirectory } from '../../src/config/paths.js';

test('derives a per-database lock path from the resolved database path', () => {
  const databasePath = '/tmp/kiokuko-relative/../kiokuko.sqlite3';
  const fingerprint = createHash('sha256').update('/tmp/kiokuko.sqlite3').digest('hex');
  assert.equal(
    getDatabaseLockPath(databasePath, {
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/tmp/xdg-runtime' },
    }),
    `/tmp/xdg-runtime/kiokuko/${fingerprint}.lock`,
  );
});

test('derives the runtime descriptor path from the runtime directory', () => {
  assert.equal(
    getRuntimeDescriptorPath({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/tmp/xdg-runtime' },
    }),
    '/tmp/xdg-runtime/kiokuko/server.json',
  );
});

test('uses XDG runtime home on Linux', () => {
  assert.equal(
    getRuntimeDirectory({
      platform: 'linux',
      env: {
        XDG_RUNTIME_DIR: '/tmp/xdg-runtime',
        XDG_DATA_HOME: '/tmp/xdg-data',
        HOME: '/tmp/home',
      },
    }),
    '/tmp/xdg-runtime/kiokuko',
  );
});

test('falls back to the platform home data directory for runtime state', () => {
  assert.equal(
    getRuntimeDirectory({ platform: 'linux', env: { HOME: '/tmp/home' } }),
    '/tmp/home/.local/share/kiokuko',
  );
  assert.equal(
    getRuntimeDirectory({ platform: 'darwin', env: { HOME: '/tmp/home' } }),
    '/tmp/home/Library/Application Support/kiokuko',
  );
  assert.equal(
    getRuntimeDirectory({
      platform: 'win32',
      env: { LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local` },
    }),
    String.raw`C:\Users\test\AppData\Local\kiokuko`,
  );
});

test('uses XDG data home on Linux', () => {
  assert.equal(
    getGlobalDatabasePath({
      platform: 'linux',
      env: {
        XDG_DATA_HOME: '/tmp/xdg-data',
        HOME: '/tmp/home',
      },
    }),
    '/tmp/xdg-data/kiokuko/kiokuko.sqlite3',
  );
});

test('falls back to the platform home data directory', () => {
  assert.equal(
    getGlobalDatabasePath({
      platform: 'linux',
      env: { HOME: '/tmp/home' },
    }),
    '/tmp/home/.local/share/kiokuko/kiokuko.sqlite3',
  );
  assert.equal(
    getGlobalDatabasePath({
      platform: 'darwin',
      env: { HOME: '/tmp/home' },
    }),
    '/tmp/home/Library/Application Support/kiokuko/kiokuko.sqlite3',
  );
  assert.equal(
    getGlobalDatabasePath({
      platform: 'win32',
      env: { LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local` },
    }),
    String.raw`C:\Users\test\AppData\Local\kiokuko\kiokuko.sqlite3`,
  );
});
