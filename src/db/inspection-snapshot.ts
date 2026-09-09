import { setTimeout as delay } from 'node:timers/promises';
import { copyFileSync, lstatSync, mkdtempSync, rmSync, type BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { KiokukoError } from '../errors.js';
import { databaseFileIdentity, requireDatabaseFileIdentity, type DatabaseFileIdentity, openConnection } from './connection.js';

function fileState(file: string): BigIntStats | undefined {
  try {
    const state = lstatSync(file, { bigint: true });
    if (!state.isFile() || state.isSymbolicLink()) throw new KiokukoError('INTEGRITY_ERROR', 'Database inspection requires regular database and WAL files');
    return state;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function unchanged(before: BigIntStats | undefined, after: BigIntStats | undefined): boolean {
  if (before === undefined || after === undefined) return before === after;
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

/**
 * Inspect an isolated database/WAL copy. SQLite read-only connections still
 * update shared-memory read marks, so opening the source would violate the
 * no-side-effects contract for unsupported databases. A concurrent writer or
 * checkpoint makes the snapshot uncertain and must force a fresh attempt.
 */
function inspectSnapshot<T>(
  source: string,
  identity: DatabaseFileIdentity,
  inspect: (database: ReturnType<typeof openConnection>) => T,
): T {
  requireDatabaseFileIdentity(source, identity);
  const before = [fileState(source), fileState(`${source}-wal`)];
  const directory = mkdtempSync(path.join(tmpdir(), 'kiokuko-db-inspection-'));
  const target = path.join(directory, 'database.sqlite3');
  let database: ReturnType<typeof openConnection> | undefined;
  try {
    copyFileSync(source, target);
    if (before[1] !== undefined) copyFileSync(`${source}-wal`, `${target}-wal`);
    requireDatabaseFileIdentity(source, identity);
    const after = [fileState(source), fileState(`${source}-wal`)];
    if (!before.every((state, index) => unchanged(state, after[index]))) {
      throw new KiokukoError('CONFLICT', 'Database changed during read-only inspection; retry', { retryInspection: true });
    }
    database = openConnection(target, { readOnly: true, expectedFileIdentity: databaseFileIdentity(target) });
    return inspect(database);
  } finally {
    try { database?.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  }
}

/** Retry only a snapshot invalidated by ordinary concurrent SQLite writes. */
export async function inspectDatabaseWithoutSideEffects<T>(source: string, identity: DatabaseFileIdentity, inspect: (database: ReturnType<typeof openConnection>) => T): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return inspectSnapshot(source, identity, inspect); }
    catch (error) {
      if (!(error instanceof KiokukoError) || error.code !== 'CONFLICT' || error.details.retryInspection !== true || attempt >= 7) throw error;
      await delay(Math.min(50, 5 * 2 ** attempt));
    }
  }
}
