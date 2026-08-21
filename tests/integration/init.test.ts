import assert from 'node:assert/strict';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';

 test('initializes an isolated database and applies migrations', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-init-'));
  const databasePath = path.join(directory, 'data', 'kiokuko.sqlite3');
  const result = await initializeDatabase({ databasePath });
  assert.equal(result.databasePath, databasePath);
  await access(databasePath);
  assert.equal(result.currentVersion, 4);
  assert.equal(result.backupPath, null);
  assert.equal(result.capabilities.driver, 'node:sqlite');
  assert.equal(result.capabilities.foreignKeys, true);
  assert.equal(result.capabilities.journalMode, 'wal');
  assert.equal(result.capabilities.busyTimeout, 5000);
});
