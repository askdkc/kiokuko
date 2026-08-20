import { backup as sqliteBackup } from 'node:sqlite';
import type { SqliteDatabase, SqliteRow } from './adapter.js';

export interface SqliteCapabilities {
  driver: 'node:sqlite';
  sqliteVersion: string;
  fts5: boolean;
  foreignKeys: boolean;
  journalMode: string;
  synchronous: string;
  busyTimeout: number;
  backup: boolean;
}

function value<T>(row: SqliteRow | undefined, key: string): T | undefined {
  return row?.[key] as T | undefined;
}

export function detectCapabilities(database: SqliteDatabase): SqliteCapabilities {
  let fts5 = false;
  try {
    database.exec('CREATE VIRTUAL TABLE temp.kiokuko_capability_fts USING fts5(content); DROP TABLE temp.kiokuko_capability_fts;');
    fts5 = true;
  } catch {
    fts5 = false;
  }

  return {
    driver: 'node:sqlite',
    sqliteVersion: String(value(database.prepare('SELECT sqlite_version() AS version').get(), 'version')),
    fts5,
    foreignKeys: value<number>(database.prepare('PRAGMA foreign_keys').get(), 'foreign_keys') === 1,
    journalMode: String(value(database.prepare('PRAGMA journal_mode').get(), 'journal_mode')).toLowerCase(),
    synchronous: String(value<string | number>(database.prepare('PRAGMA synchronous').get(), 'synchronous')).toLowerCase(),
    busyTimeout: Number(value<number>(database.prepare('PRAGMA busy_timeout').get(), 'timeout') ?? 0),
    backup: typeof sqliteBackup === 'function',
  };
}
