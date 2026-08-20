import type { SqliteDatabase } from '../db/adapter.js';
import { linkEntries } from '../memory/lifecycle.js';

export const link = linkEntries;
export type LinkCommandOptions = Parameters<typeof linkEntries>[1];
export function runLink(database: SqliteDatabase, options: LinkCommandOptions): void {
  linkEntries(database, options);
}
