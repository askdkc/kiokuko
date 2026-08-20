import assert from 'node:assert/strict';
import { backup, DatabaseSync, type DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface SqliteCapabilityContractResult {
  sqliteVersion: string;
  fts5: boolean;
  wal: boolean;
  integrityCheck: boolean;
  backup: boolean;
}

function rowValue<T extends Record<string, unknown>>(row: unknown, key: string): T[keyof T] | undefined {
  return (row as T | undefined)?.[key as keyof T];
}

export async function assertSqliteCapabilityContract(database: DatabaseSyncType): Promise<SqliteCapabilityContractResult> {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE capability_fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO capability_fixture(value) VALUES ('contract');
  `);
  const sqliteVersion = String(rowValue<{ version: string }>(database.prepare('SELECT sqlite_version() AS version').get(), 'version'));
  const fts5 = (() => {
    try {
      database.exec('CREATE VIRTUAL TABLE capability_fts USING fts5(value, content=capability_fixture, content_rowid=id);');
      return true;
    } catch {
      return false;
    }
  })();
  const journalMode = String(rowValue<{ journal_mode: string }>(database.prepare('PRAGMA journal_mode').get(), 'journal_mode')).toLowerCase();
  const wal = journalMode === 'wal';
  const integrityCheck = rowValue<{ integrity_check: string }>(database.prepare('PRAGMA integrity_check').get(), 'integrity_check') === 'ok';
  const backupAvailable = typeof backup === 'function';
  assert.equal(rowValue<{ value: string }>(database.prepare('SELECT value FROM capability_fixture').get(), 'value'), 'contract');
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-capability-'));
  const backupPath = path.join(directory, 'backup.sqlite3');
  await backup(database, backupPath);
  const backupDatabase = new DatabaseSync(backupPath);
  try {
    assert.equal(rowValue<{ integrity_check: string }>(backupDatabase.prepare('PRAGMA integrity_check').get(), 'integrity_check'), 'ok');
  } finally {
    backupDatabase.close();
  }
  return { sqliteVersion, fts5, wal, integrityCheck, backup: backupAvailable };
}
