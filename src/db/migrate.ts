import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { KiokukoError } from '../errors.js';
import type { SqliteDatabase, SqliteRow } from './adapter.js';

export interface MigrationResult {
  applied: number[];
  currentVersion: number;
}

export interface MigrationPlan {
  applied: number[];
  pending: number[];
  databaseVersion: number;
  currentVersion: number;
}

interface MigrationFile {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

interface AppliedMigrationRow extends SqliteRow {
  version: number | bigint;
  name: string;
  checksum: string;
}

const MIGRATION_FILE = /^(\d+)_([a-z0-9_-]+)\.sql$/i;
const LOCK_RETRY_LIMIT = 5;

export function defaultMigrationsDirectory(): string {
  return fileURLToPath(new URL('../../migrations/', import.meta.url));
}

function listMigrations(directory: string): MigrationFile[] {
  const migrations = readdirSync(directory)
    .map((name) => {
      const match = MIGRATION_FILE.exec(name);
      if (!match) return undefined;
      const version = Number(match[1]);
      const sql = readFileSync(path.join(directory, name), 'utf8');
      return {
        version,
        name,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    })
    .filter((migration): migration is MigrationFile => migration !== undefined)
    .sort((left, right) => left.version - right.version);
  const versions = new Set<number>();
  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
      throw new KiokukoError('INTEGRITY_ERROR', `Migration version is invalid for ${migration.name}`);
    }
    if (versions.has(migration.version)) {
      throw new KiokukoError('INTEGRITY_ERROR', `Migration version ${migration.version} is duplicated`);
    }
    versions.add(migration.version);
  }
  return migrations;
}

function hasMigrationTable(database: SqliteDatabase): boolean {
  return Boolean(database.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get());
}

function appliedMigrationRows(database: SqliteDatabase): AppliedMigrationRow[] {
  if (!hasMigrationTable(database)) return [];
  return database.prepare(`
    SELECT version, name, checksum
    FROM schema_migrations
    ORDER BY version
  `).all<AppliedMigrationRow>();
}

function migrationPlan(database: SqliteDatabase, migrations: MigrationFile[]): MigrationPlan {
  const currentVersion = migrations.at(-1)?.version ?? 0;
  const byVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const rows = appliedMigrationRows(database);
  const applied: number[] = [];

  for (const row of rows) {
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Database migration history contains an invalid version');
    }
    const migration = byVersion.get(version);
    if (!migration) {
      if (version > currentVersion) {
        throw new KiokukoError(
          'INTEGRITY_ERROR',
          `Database schema version ${version} is newer than this Kiokuko binary supports (${currentVersion})`,
          { databaseVersion: version, supportedVersion: currentVersion },
        );
      }
      throw new KiokukoError('INTEGRITY_ERROR', `Database migration version ${version} is not supported by this Kiokuko binary`);
    }
    if (row.name !== migration.name || row.checksum !== migration.checksum) {
      throw new KiokukoError(
        'INTEGRITY_ERROR',
        `Migration checksum mismatch for ${migration.name}`,
        { version: migration.version, name: migration.name },
      );
    }
    applied.push(version);
  }

  const appliedSet = new Set(applied);
  let foundPending = false;
  for (const migration of migrations) {
    if (!appliedSet.has(migration.version)) foundPending = true;
    else if (foundPending) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Database migration history is not a contiguous prefix');
    }
  }
  return {
    applied,
    pending: migrations.filter((migration) => !appliedSet.has(migration.version)).map((migration) => migration.version),
    databaseVersion: applied.at(-1) ?? 0,
    currentVersion,
  };
}

export function inspectMigrationPlan(database: SqliteDatabase, directory = defaultMigrationsDirectory()): MigrationPlan {
  return migrationPlan(database, listMigrations(directory));
}

function isLockError(error: unknown): boolean {
  return error instanceof Error && /database is locked|database table is locked|busy/i.test(error.message);
}

function waitForRetry(attempt: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, attempt * 25);
}

function withLockRetry<T>(operation: () => T): T {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isLockError(error) || attempt >= LOCK_RETRY_LIMIT) throw error;
      waitForRetry(attempt);
    }
  }
}

function rollback(database: SqliteDatabase): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // Preserve the original migration error.
  }
}

function applyOne(database: SqliteDatabase, migration: MigrationFile, migrations: MigrationFile[]): boolean {
  return withLockRetry(() => {
    database.exec('BEGIN IMMEDIATE');
    try {
      // Revalidate under the write lock so a newer binary cannot advance the
      // database between the read-only upgrade inspection and this write.
      migrationPlan(database, migrations);
      const existing = database
        .prepare('SELECT checksum FROM schema_migrations WHERE version = ?')
        .get<{ checksum: string }>(migration.version);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new KiokukoError(
            'INTEGRITY_ERROR',
            `Migration checksum mismatch for ${migration.name}`,
            { version: migration.version, name: migration.name },
          );
        }
        database.exec('COMMIT');
        return false;
      }

      database.exec(migration.sql);
      database
        .prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)')
        .run(migration.version, migration.name, migration.checksum, new Date().toISOString());
      database.exec('COMMIT');
      return true;
    } catch (error) {
      rollback(database);
      throw error;
    }
  });
}

export function migrateDatabase(database: SqliteDatabase, directory = defaultMigrationsDirectory()): MigrationResult {
  const migrations = listMigrations(directory);
  migrationPlan(database, migrations);
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied: number[] = [];
  for (const migration of migrations) {
    if (applyOne(database, migration, migrations)) applied.push(migration.version);
  }
  const currentVersion = migrations.at(-1)?.version ?? 0;
  return { applied, currentVersion };
}

export const migrate = migrateDatabase;
