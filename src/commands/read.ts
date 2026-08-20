import type { SqliteDatabase } from '../db/adapter.js';
import { readEntry } from '../memory/entries.js';
export const read = readEntry;
export type ReadCommandInput = Parameters<typeof readEntry>[1];
export function runRead(database: SqliteDatabase, input: ReadCommandInput) { return readEntry(database, input); }
