import type { SqliteDatabase } from './adapter.js';

const LOCK_RETRY_LIMIT = 5;

function isLockError(error: unknown): boolean {
  return error instanceof Error && /database is locked|database table is locked|busy/i.test(error.message);
}

function waitForRetry(attempt: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, attempt * 25);
}

function rollback(database: SqliteDatabase): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // Preserve the original operation error.
  }
}

/** Run a synchronous write transaction with bounded retry for SQLite lock errors only. */
export function withImmediateTransaction<T>(database: SqliteDatabase, operation: () => T): T {
  for (let attempt = 1; ; attempt += 1) {
    try {
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = operation();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        rollback(database);
        throw error;
      }
    } catch (error) {
      if (!isLockError(error) || attempt >= LOCK_RETRY_LIMIT) throw error;
      waitForRetry(attempt);
    }
  }
}
