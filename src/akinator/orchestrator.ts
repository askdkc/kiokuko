import type { SqliteDatabase } from '../db/adapter.js';
import {
  answerAkinatorService,
  getAkinatorContextService,
  startAkinatorService,
} from './service.js';
import type {
  AkinatorContextInput,
  AnswerAkinatorInput,
  StartAkinatorInput,
} from './service.js';
import type { AkinatorContext, AkinatorResult } from './types.js';

export type { AkinatorContextInput, AnswerAkinatorInput, StartAkinatorInput } from './service.js';

export function startAkinator(
  database: SqliteDatabase,
  input: StartAkinatorInput,
): Promise<AkinatorResult> {
  return startAkinatorService(database, input);
}

export function answerAkinator(
  database: SqliteDatabase,
  input: AnswerAkinatorInput,
): Promise<AkinatorResult> {
  return answerAkinatorService(database, input);
}

export function getAkinatorContext(
  database: SqliteDatabase,
  input: AkinatorContextInput,
): Promise<AkinatorContext> {
  return getAkinatorContextService(database, input);
}
