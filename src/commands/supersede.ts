import type { SqliteDatabase } from '../db/adapter.js';
import { supersedeEntry } from '../memory/lifecycle.js';

export const supersede = supersedeEntry;
export type SupersedeCommandOptions = Parameters<typeof supersedeEntry>[1];
export function runSupersede(database: SqliteDatabase, options: SupersedeCommandOptions) {
  return supersedeEntry(database, options);
}
