import type { SqliteDatabase } from '../db/adapter.js';
import { searchEntries } from '../memory/retrieval.js';
export const search = searchEntries;
export type SearchCommandInput = Parameters<typeof searchEntries>[1];
export function runSearch(database: SqliteDatabase, input: SearchCommandInput) { return searchEntries(database, input); }
