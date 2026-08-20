import type { SqliteDatabase } from '../db/adapter.js';
import { recallEntries } from '../memory/retrieval.js';
export const recall = recallEntries;
export type RecallCommandInput = Parameters<typeof recallEntries>[1];
export function runRecall(database: SqliteDatabase, input: RecallCommandInput) { return recallEntries(database, input); }
