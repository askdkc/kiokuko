import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { NodeSqliteAdapter } from './adapter.js';
import { withSqliteLockRetry } from './sqlite-retry.js';
import { KiokukoError } from '../errors.js';

export interface DatabaseFileIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface ConnectionOptions {
  readonly readOnly?: boolean;
  readonly expectedFileIdentity?: DatabaseFileIdentity;
}

export function databaseFileIdentity(filePath: string): DatabaseFileIdentity {
  const status = lstatSync(filePath, { bigint: true });
  if (!status.isFile()) {
    throw new KiokukoError('INTEGRITY_ERROR', 'SQLite database path is not a regular non-symbolic-link file');
  }
  return Object.freeze({ device: status.dev, inode: status.ino });
}

export function sameDatabaseFileIdentity(left: DatabaseFileIdentity, right: DatabaseFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function requireDatabaseFileIdentity(filePath: string, expected: DatabaseFileIdentity): void {
  let actual: DatabaseFileIdentity;
  try {
    actual = databaseFileIdentity(filePath);
  } catch (error) {
    const failure = new KiokukoError(
      'CONFLICT',
      'SQLite database file identity changed during initialization',
    );
    Object.defineProperty(failure, 'cause', { value: error });
    throw failure;
  }
  if (!sameDatabaseFileIdentity(actual, expected)) {
    throw new KiokukoError(
      'CONFLICT',
      'SQLite database file identity changed during initialization',
    );
  }
}

function configureJournalMode(database: DatabaseSync): void {
  withSqliteLockRetry(() => database.exec('PRAGMA journal_mode = WAL;'));
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
  try {
    if (options.expectedFileIdentity !== undefined) {
      if (filePath === ':memory:') {
        throw new KiokukoError('VALIDATION_ERROR', 'An in-memory database cannot have a file identity');
      }
      // This check deliberately precedes chmod and every writable PRAGMA.
      requireDatabaseFileIdentity(filePath, options.expectedFileIdentity);
    }
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
  } catch (error) {
    try {
      database.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'SQLite connection initialization failed and closing it also failed',
      );
    }
    throw error;
  }
}
