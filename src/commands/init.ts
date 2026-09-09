import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { getGlobalDatabasePath } from '../config/paths.js';
import { detectCapabilities, type SqliteCapabilities } from '../db/capabilities.js';
import { databaseFileIdentity, openConnection, requireDatabaseFileIdentity, type DatabaseFileIdentity } from '../db/connection.js';
import { inspectDatabaseWithoutSideEffects } from '../db/inspection-snapshot.js';
import { inspectMigrationSnapshot, loadMigrationSnapshot, migrateDatabaseSnapshotInTransaction, type MigrationPlan } from '../db/migrate.js';
import { withSqliteLockRetry } from '../db/sqlite-retry.js';
import { rollbackFailedTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';

export interface InitOptions { databasePath?: string; migrationsDirectory?: string; }
export interface InitHooks {
  readonly afterPreflight?: () => void | Promise<void>;
  readonly afterPathReserved?: () => void | Promise<void>;
  readonly afterWritableOpen?: () => void | Promise<void>;
  readonly beforeCommit?: () => void;
}
export interface InitResult {
  databasePath: string;
  dataDirectory: string;
  applied: number[];
  currentVersion: number;
  capabilities: SqliteCapabilities;
}

function requireForeignKeyIntegrity(connection: ReturnType<typeof openConnection>, stage: 'before' | 'after'): void {
  const violations = connection.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    throw new KiokukoError(
      'INTEGRITY_ERROR',
      `Database foreign-key integrity check failed ${stage} migration`,
      { stage, violationCount: violations.length },
    );
  }
}

function dataVersion(connection: ReturnType<typeof openConnection>): number {
  const value = connection.prepare('PRAGMA data_version').get()?.data_version;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new KiokukoError('INTEGRITY_ERROR', 'SQLite data-version probe returned an invalid result');
  }
  return value;
}

function samePlan(left: MigrationPlan, right: MigrationPlan): boolean {
  return left.databaseVersion === right.databaseVersion
    && left.currentVersion === right.currentVersion
    && left.applied.length === right.applied.length
    && left.applied.every((version, index) => version === right.applied[index])
    && left.pending.length === right.pending.length
    && left.pending.every((version, index) => version === right.pending[index])
    && left.migrations.length === right.migrations.length
    && left.migrations.every((migration, index) => {
      const candidate = right.migrations[index];
      return candidate !== undefined
        && migration.version === candidate.version
        && migration.name === candidate.name
        && migration.checksum === candidate.checksum
        && migration.sql === candidate.sql;
    });
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

interface DatabasePathReservation {
  readonly appeared: boolean;
  readonly descriptor?: number;
  readonly identity?: DatabaseFileIdentity;
}

function reserveAbsentDatabasePath(databasePath: string, dataDirectory: string): DatabasePathReservation {
  if (databasePath === ':memory:') return { appeared: false };
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  try {
    const descriptor = openSync(databasePath, 'wx', 0o600);
    try {
      const status = fstatSync(descriptor, { bigint: true });
      if (!status.isFile()) {
        throw new KiokukoError('INTEGRITY_ERROR', 'Reserved SQLite database path is not a regular file');
      }
      return {
        appeared: false,
        descriptor,
        identity: Object.freeze({ device: status.dev, inode: status.ino }),
      };
    } catch (error) {
      try {
        closeSync(descriptor);
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          'Database path reservation failed and closing its descriptor also failed',
        );
      }
      throw error;
    }
  } catch (error) {
    if (isAlreadyExistsError(error)) return { appeared: true };
    throw error;
  }
}

function requireUntouchedReservation(
  descriptor: number,
  expectedIdentity: DatabaseFileIdentity,
): void {
  const status = fstatSync(descriptor, { bigint: true });
  if (!status.isFile()
    || status.dev !== expectedIdentity.device
    || status.ino !== expectedIdentity.inode
    || status.size !== 0n) {
    throw new KiokukoError(
      'CONFLICT',
      'Reserved database file changed before SQLite opened it; initialization was not applied',
    );
  }
}

function requireFreshDatabaseMetadata(connection: ReturnType<typeof openConnection>): void {
  const userVersion = connection.prepare('PRAGMA user_version').get()?.user_version;
  const applicationId = connection.prepare('PRAGMA application_id').get()?.application_id;
  const schemaVersion = connection.prepare('PRAGMA schema_version').get()?.schema_version;
  if (userVersion !== 0 || applicationId !== 0 || schemaVersion !== 0) {
    throw new KiokukoError(
      'CONFLICT',
      'Fresh database metadata changed after its path was reserved; initialization was not applied',
    );
  }
}

function rejectUnsupportedDatabase(databasePath: string, reason: string): never {
  throw new KiokukoError('INTEGRITY_ERROR',
    `Unsupported or invalid database at ${databasePath}: ${reason}. Keep this database unchanged and initialize a new absolute directory with KIOKUKO_DATA_DIR=/absolute/new-directory kiokuko init.`,
    { databasePath, reason });
}

function requireSafeInitialSidecars(databasePath: string, fresh: boolean): void {
  for (const suffix of fresh ? ['-wal', '-shm', '-journal'] : ['-journal']) {
    try { lstatSync(`${databasePath}${suffix}`); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
    rejectUnsupportedDatabase(databasePath, fresh
      ? `Existing ${suffix} file cannot belong to a fresh database`
      : 'A rollback journal requires recovery outside this version');
  }
}

/** Initialize a fresh database, or validate this major version's existing history. */
export async function initializeDatabase(options: InitOptions = {}, hooks: InitHooks = {}): Promise<InitResult> {
  const databasePath = options.databasePath ?? getGlobalDatabasePath();
  if (databasePath === ':memory:') throw new KiokukoError('VALIDATION_ERROR', 'Initialization requires a persistent database path');
  const dataDirectory = dirname(databasePath);
  const snapshot = loadMigrationSnapshot(options.migrationsDirectory);
  const existed = existsSync(databasePath);
  requireSafeInitialSidecars(databasePath, !existed);
  let identity = existed ? databaseFileIdentity(databasePath) : undefined;
  let plan: MigrationPlan | undefined;
  if (existed) {
    try {
      plan = await inspectDatabaseWithoutSideEffects(databasePath, identity!, inspection => {
        const inspected = inspectMigrationSnapshot(inspection, snapshot);
        requireForeignKeyIntegrity(inspection, 'before');
        return inspected;
      });
    } catch (error) {
      if (error instanceof Error && (error instanceof KiokukoError && error.code === 'INTEGRITY_ERROR'
        || 'code' in error && error.code === 'ERR_SQLITE_ERROR')) {
        rejectUnsupportedDatabase(databasePath, error.message);
      }
      throw error;
    }
  }
  await hooks.afterPreflight?.();
  const reservation = existed ? { appeared: false } : reserveAbsentDatabasePath(databasePath, dataDirectory);
  if (reservation.appeared) throw new KiokukoError('CONFLICT', 'Database appeared after preflight; retry initialization');
  const descriptor = reservation.descriptor;
  if (reservation.identity !== undefined) identity = reservation.identity;
  let database: ReturnType<typeof openConnection> | undefined;
  try {
    if (descriptor !== undefined) {
      await hooks.afterPathReserved?.();
      requireUntouchedReservation(descriptor, identity!);
      requireSafeInitialSidecars(databasePath, true);
    }
    requireDatabaseFileIdentity(databasePath, identity!);
    database = openConnection(databasePath, { expectedFileIdentity: identity! });
    const version = dataVersion(database);
    if (descriptor !== undefined) requireFreshDatabaseMetadata(database);
    await hooks.afterWritableOpen?.();
    if (dataVersion(database) !== version) throw new KiokukoError('CONFLICT', 'Database changed after writable open');
    withSqliteLockRetry(() => database!.exec('BEGIN IMMEDIATE'));
    try {
      requireDatabaseFileIdentity(databasePath, identity!);
      if (dataVersion(database) !== version) throw new KiokukoError('CONFLICT', 'Database changed before initialization acquired its lock');
      if (descriptor !== undefined) requireFreshDatabaseMetadata(database);
      const locked = inspectMigrationSnapshot(database, snapshot);
      if (plan !== undefined && !samePlan(plan, locked)) throw new KiokukoError('CONFLICT', 'Database history changed after preflight');
      requireForeignKeyIntegrity(database, 'before');
      const migration = migrateDatabaseSnapshotInTransaction(database, snapshot);
      requireForeignKeyIntegrity(database, 'after');
      hooks.beforeCommit?.();
      requireDatabaseFileIdentity(databasePath, identity!);
      withSqliteLockRetry(() => database!.exec('COMMIT'));
      return { databasePath, dataDirectory, applied: migration.applied, currentVersion: migration.currentVersion, capabilities: detectCapabilities(database) };
    } catch (error) { rollbackFailedTransaction(database, error); throw error; }
  } finally {
    try { database?.close(); } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
}
