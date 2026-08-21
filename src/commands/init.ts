import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensurePlatformDataDirectory, getGlobalDatabasePath } from '../config/paths.js';
import { detectCapabilities, type SqliteCapabilities } from '../db/capabilities.js';
import { openConnection } from '../db/connection.js';
import { defaultMigrationsDirectory, inspectMigrationPlan, migrateDatabase } from '../db/migrate.js';
import { createPreMigrationBackup } from '../db/upgrade-backup.js';
import { rebuildHybridSearch } from '../memory/rebuild-search.js';

export interface InitOptions {
  databasePath?: string;
  migrationsDirectory?: string;
}

export interface InitResult {
  databasePath: string;
  dataDirectory: string;
  applied: number[];
  currentVersion: number;
  backupPath: string | null;
  capabilities: SqliteCapabilities;
}

export async function initializeDatabase(options: InitOptions = {}): Promise<InitResult> {
  const databasePath = options.databasePath ?? getGlobalDatabasePath();
  const dataDirectory = options.databasePath
    ? dirname(databasePath)
    : await ensurePlatformDataDirectory();
  const migrationsDirectory = options.migrationsDirectory ?? defaultMigrationsDirectory();
  let backupPath: string | null = null;

  if (existsSync(databasePath)) {
    const inspection = openConnection(databasePath, { readOnly: true });
    try {
      const plan = inspectMigrationPlan(inspection, migrationsDirectory);
      if (plan.databaseVersion > 0 && plan.pending.length > 0) {
        backupPath = await createPreMigrationBackup(
          inspection,
          databasePath,
          plan.databaseVersion,
          plan.currentVersion,
        );
      }
    } finally {
      inspection.close();
    }
  }

  const connection = openConnection(databasePath);
  try {
    const migration = migrateDatabase(connection, migrationsDirectory);
    // Migration 005 can only backfill the raw SQLite projections. Build the
    // application-owned structured signal projection once when that migration
    // is applied; subsequent writes keep it synchronized transactionally.
    if (migration.applied.some((version) => version >= 5)) rebuildHybridSearch(connection);
    return {
      databasePath,
      dataDirectory,
      applied: migration.applied,
      currentVersion: migration.currentVersion,
      backupPath,
      capabilities: detectCapabilities(connection),
    };
  } finally {
    connection.close();
  }
}
