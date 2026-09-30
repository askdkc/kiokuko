import { KiokukoError } from '../errors.js';
import { LOCAL_RERANKER_PRESET } from './preset.js';

export type FeatureMode = 'off' | 'observe' | 'active';

export interface RerankerConfig {
  readonly mode: FeatureMode;
  readonly presetId: string;
  readonly revision: string;
  readonly dtype: 'q8';
  readonly maxCandidates: 32;
  readonly maxInputBytes: number;
  readonly maxTokens: 512;
  readonly timeoutMs: number;
  readonly maxConcurrency: 1;
  readonly queueLimit: 2;
}

function boundedInteger(value: string | undefined, field: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/u.test(value)) throw new KiokukoError('VALIDATION_ERROR', `${field} must be an integer between ${minimum} and ${maximum}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new KiokukoError('VALIDATION_ERROR', `${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function readRerankerConfig(env: NodeJS.ProcessEnv = process.env): RerankerConfig {
  const mode = env.KIOKUKO_RERANKER_MODE ?? 'off';
  if (mode !== 'off' && mode !== 'observe' && mode !== 'active') {
    throw new KiokukoError('VALIDATION_ERROR', 'KIOKUKO_RERANKER_MODE must be off, observe, or active');
  }
  if (mode === 'off') {
    return Object.freeze({
      mode,
      presetId: LOCAL_RERANKER_PRESET.id,
      revision: LOCAL_RERANKER_PRESET.revision,
      dtype: LOCAL_RERANKER_PRESET.dtype,
      maxCandidates: 32,
      maxInputBytes: 262_144,
      maxTokens: LOCAL_RERANKER_PRESET.maximumTokens,
      timeoutMs: 60_000,
      maxConcurrency: 1,
      queueLimit: 2,
    });
  }
  const timeoutMs = boundedInteger(env.KIOKUKO_RERANKER_TIMEOUT_MS, 'KIOKUKO_RERANKER_TIMEOUT_MS', 60_000, 1_000, 120_000);
  const maxInputBytes = boundedInteger(env.KIOKUKO_RERANKER_MAX_INPUT_BYTES, 'KIOKUKO_RERANKER_MAX_INPUT_BYTES', 262_144, 1_024, 1_048_576);
  return Object.freeze({
    mode,
    presetId: LOCAL_RERANKER_PRESET.id,
    revision: LOCAL_RERANKER_PRESET.revision,
    dtype: LOCAL_RERANKER_PRESET.dtype,
    maxCandidates: 32,
    maxInputBytes,
    maxTokens: LOCAL_RERANKER_PRESET.maximumTokens,
    timeoutMs,
    maxConcurrency: 1,
    queueLimit: 2,
  });
}
