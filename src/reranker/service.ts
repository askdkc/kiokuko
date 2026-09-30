import { Buffer } from 'node:buffer';
import type { RerankerConfig } from './config.js';
import { readRerankerConfig } from './config.js';
import { KiokukoError } from '../errors.js';
import { rerankerStatus } from './setup.js';
import { createLocalRerankerRuntime, MAX_RERANKER_BATCH_BYTES, type LocalRerankerRuntime, type RerankerScore } from './runtime.js';

export interface RerankerCandidateText {
  readonly key: string;
  readonly title: string;
  readonly summary: string | null;
  readonly body: string;
}

export interface RerankerScoreResult {
  readonly scores: ReadonlyMap<string, number>;
  readonly unscored: ReadonlyMap<string, 'input_limit' | 'token_limit'>;
  readonly failed: boolean;
  readonly failureReason?: string;
}

export interface RerankerDiagnostics {
  readonly mode: 'observe' | 'active';
  readonly state: 'observed' | 'applied' | 'unavailable' | 'failed' | 'no_candidates';
  readonly candidateCount: number;
  readonly scoredCount: number;
  readonly unscoredCount: number;
  readonly reason?: string;
}

let sharedRuntime: LocalRerankerRuntime | undefined;
let sharedIdentity = '';

function rankingText(candidate: RerankerCandidateText): string {
  return [candidate.title, candidate.summary ?? '', candidate.body].filter((value) => value.length > 0).join('\n\n');
}

function failClosed(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return error instanceof KiokukoError
    && (error.code === 'INTEGRITY_ERROR' || error.code === 'SECURITY_REJECTION'
      || error.code === 'CONFLICT' || error.code === 'NOT_FOUND');
}

function sanitizedReason(error: unknown): string {
  if (error instanceof KiokukoError) return error.code.toLowerCase();
  return 'inference_failed';
}

async function currentRuntime(identity: string, config: RerankerConfig): Promise<LocalRerankerRuntime> {
  if (sharedRuntime !== undefined && sharedIdentity === identity) return sharedRuntime;
  if (sharedRuntime !== undefined) await sharedRuntime.close();
  sharedRuntime = undefined;
  sharedIdentity = '';
  const status = await rerankerStatus();
  if (status.state === 'missing') throw new KiokukoError('NOT_FOUND', 'Configured reranker model is not installed');
  if (status.state === 'invalid') throw new KiokukoError('INTEGRITY_ERROR', 'Configured reranker model failed file verification');
  sharedRuntime = createLocalRerankerRuntime(status.directory, {
    timeoutMs: config.timeoutMs,
    maxInputBytes: config.maxInputBytes,
  });
  sharedIdentity = identity;
  return sharedRuntime;
}

export async function scoreLocalReranker(
  query: string,
  candidates: readonly RerankerCandidateText[],
  options: { readonly config?: RerankerConfig; readonly signal?: AbortSignal } = {},
): Promise<RerankerScoreResult> {
  const config = options.config ?? readRerankerConfig();
  if (config.mode === 'off') return { scores: new Map(), unscored: new Map(), failed: false };
  if (candidates.length > config.maxCandidates) throw new KiokukoError('VALIDATION_ERROR', 'Reranker candidate count exceeds its configured limit');
  if (candidates.length === 0) return { scores: new Map(), unscored: new Map(), failed: false };
  if (options.signal?.aborted) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Reranker scoring was cancelled');

  const identity = `${config.presetId}\u0000${config.revision}\u0000${config.dtype}\u0000${config.timeoutMs}\u0000${config.maxInputBytes}`;
  const scoreable: Array<{ key: string; query: string; document: string }> = [];
  const unscored = new Map<string, 'input_limit' | 'token_limit'>();
  let totalInputBytes = 0;
  for (const candidate of candidates) {
    const document = rankingText(candidate);
    const inputBytes = Buffer.byteLength(query, 'utf8') + Buffer.byteLength(document, 'utf8');
    if (inputBytes > config.maxInputBytes || totalInputBytes + inputBytes > MAX_RERANKER_BATCH_BYTES) {
      unscored.set(candidate.key, 'input_limit');
      continue;
    }
    totalInputBytes += inputBytes;
    scoreable.push({ key: candidate.key, query, document });
  }
  if (scoreable.length === 0) return { scores: new Map(), unscored, failed: false };

  const scores = new Map<string, number>();
  try {
    const response = await (await currentRuntime(identity, config)).score(
      scoreable.map(({ query: pairQuery, document }) => ({ query: pairQuery, document })),
      { ...(options.signal === undefined ? {} : { signal: options.signal }) },
    );
    if (options.signal?.aborted) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Reranker scoring was cancelled');
    response.forEach((result: RerankerScore, index) => {
      const candidate = candidates.find((item) => item.key === scoreable[index]!.key)!;
      if (result.score === null) unscored.set(candidate.key, result.reason ?? 'token_limit');
      else scores.set(candidate.key, result.score);
    });
    return { scores, unscored, failed: false };
  } catch (error) {
    if (failClosed(error, options.signal)) throw error;
    return { scores: new Map(), unscored, failed: true, failureReason: sanitizedReason(error) };
  }
}

/** Reorders scored positions only; candidates with no score keep their baseline slots. */
export function reorderScoredCandidates<T extends { readonly key: string }>(
  candidates: readonly T[],
  scores: ReadonlyMap<string, number>,
  maximumCandidates = 32,
): T[] {
  const result = [...candidates];
  const end = Math.min(result.length, maximumCandidates);
  const slots: number[] = [];
  const ranked: T[] = [];
  const baselinePosition = new Map<string, number>();
  for (let index = 0; index < end; index += 1) {
    const candidate = result[index]!;
    if (scores.has(candidate.key)) {
      slots.push(index);
      ranked.push(candidate);
      baselinePosition.set(candidate.key, index);
    }
  }
  ranked.sort((left, right) => (scores.get(right.key)! - scores.get(left.key)!)
    || baselinePosition.get(left.key)! - baselinePosition.get(right.key)!);
  slots.forEach((slot, index) => { result[slot] = ranked[index]!; });
  return result;
}

/** Score only the supplied eligible baseline prefix; active mode moves scored entries within their existing slots. */
export async function rerankCandidateRecords<T extends RerankerCandidateText>(
  query: string,
  candidates: readonly T[],
  config: RerankerConfig,
  signal?: AbortSignal,
): Promise<{ readonly candidates: T[]; readonly diagnostics?: RerankerDiagnostics }> {
  if (config.mode === 'off') return { candidates: [...candidates] };
  const prefix = candidates.slice(0, config.maxCandidates);
  if (prefix.length === 0) {
    return { candidates: [...candidates], diagnostics: {
      mode: config.mode, state: 'no_candidates', candidateCount: 0, scoredCount: 0, unscoredCount: 0,
    } };
  }
  const keys = new Set<string>();
  for (const candidate of prefix) {
    if (keys.has(candidate.key)) throw new KiokukoError('INTEGRITY_ERROR', 'Reranker candidates contain duplicate identities');
    keys.add(candidate.key);
  }
  let scoring: RerankerScoreResult;
  try {
    scoring = await scoreLocalReranker(query, prefix, { config, ...(signal === undefined ? {} : { signal }) });
  } catch (error) {
    const unavailablePreset = error instanceof KiokukoError && error.code === 'NOT_FOUND';
    if (config.mode === 'active' || failClosed(error, signal) && !unavailablePreset) throw error;
    return { candidates: [...candidates], diagnostics: {
      mode: config.mode, state: 'unavailable', candidateCount: prefix.length, scoredCount: 0,
      unscoredCount: prefix.length, reason: sanitizedReason(error),
    } };
  }
  if (scoring.failed) {
    return { candidates: [...candidates], diagnostics: {
      mode: config.mode, state: 'failed', candidateCount: prefix.length, scoredCount: 0,
      unscoredCount: prefix.length, reason: scoring.failureReason ?? 'inference_failed',
    } };
  }
  const selected = config.mode === 'active'
    ? reorderScoredCandidates(prefix, scoring.scores, config.maxCandidates)
    : [...prefix];
  return {
    candidates: [...selected, ...candidates.slice(prefix.length)],
    diagnostics: {
      mode: config.mode,
      state: config.mode === 'active' ? 'applied' : 'observed',
      candidateCount: prefix.length,
      scoredCount: scoring.scores.size,
      unscoredCount: scoring.unscored.size,
    },
  };
}

export async function closeSharedRerankerRuntime(): Promise<void> {
  const runtime = sharedRuntime;
  sharedRuntime = undefined;
  sharedIdentity = '';
  await runtime?.close();
}
