import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { chmodSync, mkdirSync } from 'node:fs';
import { NodeSqliteAdapter } from './adapter.js';

const JOURNAL_MODE_RETRY_LIMIT = 5;

export interface ConnectionOptions {
  readonly readOnly?: boolean;
}

function isLockError(error: unknown): boolean {
  return error instanceof Error && /database is locked|database table is locked|busy/i.test(error.message);
}

function configureJournalMode(database: DatabaseSync): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      database.exec('PRAGMA journal_mode = WAL;');
      return;
    } catch (error) {
      if (!isLockError(error) || attempt >= JOURNAL_MODE_RETRY_LIMIT) throw error;
      const buffer = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(buffer, 0, 0, attempt * 25);
    }
  }
}

export function openConnection(filePath: string, options: ConnectionOptions = {}): NodeSqliteAdapter {
  if (filePath !== ':memory:') {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  }
  const database = new DatabaseSync(filePath, {
    enableForeignKeyConstraints: true,
    timeout: 5000,
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
  });
  if (filePath !== ':memory:' && !options.readOnly) chmodSync(filePath, 0o600);
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  if (!options.readOnly) {
    configureJournalMode(database);
    database.exec('PRAGMA synchronous = NORMAL;');
  }
  return new NodeSqliteAdapter(filePath, database);
}
