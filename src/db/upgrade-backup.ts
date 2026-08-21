import { randomBytes } from 'node:crypto';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { KiokukoError } from '../errors.js';
import type { SqliteDatabase } from './adapter.js';

function backupName(databasePath: string, fromVersion: number, toVersion: number): string {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17);
  const nonce = randomBytes(8).toString('hex');
  return `${path.basename(databasePath)}.pre-upgrade-v${fromVersion}-to-v${toVersion}-${timestamp}-${nonce}.sqlite3`;
}

export async function createPreMigrationBackup(
  database: SqliteDatabase,
  databasePath: string,
  fromVersion: number,
  toVersion: number,
): Promise<string> {
  const backupDirectory = path.join(path.dirname(databasePath), 'backups');
  const output = path.join(backupDirectory, backupName(databasePath, fromVersion, toVersion));
  try {
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    await chmod(backupDirectory, 0o700);
    await database.backup(output);
    await chmod(output, 0o600);

    // The backup API copies the source journal mode. Normalize only the backup
    // to DELETE mode so it remains a self-contained file without WAL sidecars.
    const verification = new DatabaseSync(output, { timeout: 5000, enableForeignKeyConstraints: true });
    try {
      verification.exec('PRAGMA journal_mode = DELETE;');
      const row = verification.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined;
      const integrity = row?.integrity_check;
      if (integrity !== 'ok') throw new Error('backup integrity check failed');
    } finally {
      verification.close();
    }
    return output;
  } catch (error) {
    await Promise.all([
      unlink(output).catch(() => undefined),
      unlink(`${output}-wal`).catch(() => undefined),
      unlink(`${output}-shm`).catch(() => undefined),
    ]);
    throw new KiokukoError(
      'DATABASE_ERROR',
      'Could not create and verify the pre-migration backup; the database was not migrated',
      { cause: error instanceof Error ? error.message : 'unknown backup error' },
    );
  }
}
