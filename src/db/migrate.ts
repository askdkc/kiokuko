import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { KiokukoError } from '../errors.js';
import type { SqliteDatabase } from './adapter.js';

export interface MigrationResult {
  applied: number[];
  currentVersion: number;
}

interface MigrationFile {
  version: number;
  name: string;
  checksum: string;
  sql: string;
}

const MIGRATION_FILE = /^(\d+)_([a-z0-9_-]+)\.sql$/i;
const LOCK_RETRY_LIMIT = 5;

export function defaultMigrationsDirectory(): string {
  return fileURLToPath(new URL('../../migrations/', import.meta.url));
}

function listMigrations(directory: string): MigrationFile[] {
  return readdirSync(directory)
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

function applyOne(database: SqliteDatabase, migration: MigrationFile): boolean {
  return withLockRetry(() => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const existing = database
        .prepare('SELECT checksum FROM schema_migrations WHERE version = ?')
        .get<{ checksum: string }>(migration.version);
      if (existing) {
        database.exec('COMMIT');
        if (existing.checksum !== migration.checksum) {
          throw new KiokukoError(
            'INTEGRITY_ERROR',
            `Migration checksum mismatch for ${migration.name}`,
            { version: migration.version, name: migration.name },
          );
        }
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
    if (applyOne(database, migration)) applied.push(migration.version);
  }
  const currentVersion = migrations.at(-1)?.version ?? 0;
  return { applied, currentVersion };
}

export const migrate = migrateDatabase;
