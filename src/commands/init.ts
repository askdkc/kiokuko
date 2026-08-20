import { dirname } from 'node:path';
import { ensurePlatformDataDirectory, getGlobalDatabasePath } from '../config/paths.js';
import { detectCapabilities, type SqliteCapabilities } from '../db/capabilities.js';
import { openConnection } from '../db/connection.js';
import { defaultMigrationsDirectory, migrateDatabase } from '../db/migrate.js';

export interface InitOptions {
  databasePath?: string;
  migrationsDirectory?: string;
}

export interface InitResult {
  databasePath: string;
  dataDirectory: string;
  applied: number[];
  currentVersion: number;
  capabilities: SqliteCapabilities;
}

export async function initializeDatabase(options: InitOptions = {}): Promise<InitResult> {
  const databasePath = options.databasePath ?? getGlobalDatabasePath();
  const dataDirectory = options.databasePath
    ? dirname(databasePath)
    : await ensurePlatformDataDirectory();
  const connection = openConnection(databasePath);
  try {
    const migration = migrateDatabase(connection, options.migrationsDirectory ?? defaultMigrationsDirectory());
    return {
      databasePath,
      dataDirectory,
      applied: migration.applied,
      currentVersion: migration.currentVersion,
      capabilities: detectCapabilities(connection),
    };
  } finally {
    connection.close();
  }
}
