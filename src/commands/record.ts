import type { SqliteDatabase } from '../db/adapter.js';
import { recordEntry } from '../memory/entries.js';
export const record = recordEntry;
export type RecordCommandInput = Parameters<typeof recordEntry>[1];
export function runRecord(database: SqliteDatabase, input: RecordCommandInput) { return recordEntry(database, input); }
