import type { SqliteDatabase } from '../db/adapter.js';
import { promoteEntry } from '../memory/lifecycle.js';

export const promote = promoteEntry;
export type PromoteCommandOptions = Parameters<typeof promoteEntry>[1];
export function runPromote(database: SqliteDatabase, options: PromoteCommandOptions) {
  return promoteEntry(database, options);
}
