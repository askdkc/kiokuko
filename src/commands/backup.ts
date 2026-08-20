import { initializeDatabase } from './init.js';
import { openConnection } from '../db/connection.js';

export async function createBackup(output: string, databasePath?: string): Promise<{ output: string; databasePath: string }> {
  const initialized = await initializeDatabase(databasePath === undefined ? {} : { databasePath });
  const database = openConnection(initialized.databasePath);
  try {
    await database.backup(output);
  } finally {
    database.close();
  }
  return { output, databasePath: initialized.databasePath };
}
