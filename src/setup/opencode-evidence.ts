import { createHash } from 'node:crypto';

export const OPENCODE_CAPTURE_PROFILES = ['off', 'minimal', 'standard'] as const;
export type OpenCodeCaptureProfile = (typeof OPENCODE_CAPTURE_PROFILES)[number];
export const OPENCODE_MODES = ['advisory', 'strict'] as const;
export type OpenCodeMode = (typeof OPENCODE_MODES)[number];

export interface OpenCodeEvidence {
  changedPaths?: string[];
  errorSignatures?: string[];
  commands?: Array<{ executable: string; classification?: string; exitCode?: number; outcome: 'passed' | 'failed' | 'unknown'; digest?: string }>;
  tests?: Array<{ runner: string; target?: string; outcome: 'passed' | 'failed' | 'unknown'; digest?: string }>;
  verification?: { outcome: 'fresh' | 'stale' | 'failed' | 'unknown' };
}

export interface OpenCodeEvidenceAccumulator {
  readonly profile: OpenCodeCaptureProfile;
  evidence: OpenCodeEvidence;
}

const MAX_ITEMS = 100;
const CONTROL = /[\u0000-\u001f\u007f]/u;

function boundedPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500 || CONTROL.test(value) || value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.split(/[\\/]/u).includes('..')) return undefined;
  return value.replaceAll('\\', '/');
}

function boundedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 500 && !CONTROL.test(value) && !/(?:api[_-]?key|token|password|secret|authorization)/iu.test(value) ? value : undefined;
}

function digest(value: unknown): string | undefined {
  const text = boundedString(value);
  return text === undefined ? undefined : createHash('sha256').update(text, 'utf8').digest('hex');
}

export function createOpenCodeEvidenceAccumulator(profile: OpenCodeCaptureProfile): OpenCodeEvidenceAccumulator {
  return { profile, evidence: {} };
}

export function observeOpenCodeTool(
  accumulator: OpenCodeEvidenceAccumulator,
  input: { tool: string },
  output: { args?: unknown; metadata?: unknown },
  outcome: 'passed' | 'failed' | 'unknown' = 'unknown',
): void {
  if (accumulator.profile === 'off') return;
  const args = output.args && typeof output.args === 'object' && !Array.isArray(output.args) ? output.args as Record<string, unknown> : {};
  const metadata = output.metadata && typeof output.metadata === 'object' && !Array.isArray(output.metadata) ? output.metadata as Record<string, unknown> : {};
  const paths = [...(Array.isArray(args.changedPaths) ? args.changedPaths : []), ...(Array.isArray(metadata.changedPaths) ? metadata.changedPaths : [])]
    .map(boundedPath).filter((value): value is string => value !== undefined);
  accumulator.evidence.changedPaths = [...new Set([...(accumulator.evidence.changedPaths ?? []), ...paths])].slice(0, MAX_ITEMS);
  const executable = input.tool.toLowerCase().replace(/[^a-z0-9_.-]+/gu, '_').slice(0, 200);
  accumulator.evidence.commands = [...(accumulator.evidence.commands ?? []), { executable, classification: 'opencode-tool', outcome }].slice(-MAX_ITEMS);
  if (accumulator.profile !== 'standard') return;
  const error = boundedString(metadata.errorSignature);
  if (error !== undefined) accumulator.evidence.errorSignatures = [...new Set([...(accumulator.evidence.errorSignatures ?? []), error])].slice(0, MAX_ITEMS);
  const runner = boundedString(metadata.testRunner);
  if (runner !== undefined) {
    const target = boundedString(metadata.testTarget);
    const testDigest = digest(metadata.testDigest);
    const test = { runner, ...(target === undefined ? {} : { target }), outcome, ...(testDigest === undefined ? {} : { digest: testDigest }) };
    accumulator.evidence.tests = [...(accumulator.evidence.tests ?? []), test].slice(-MAX_ITEMS);
  }
  const verification = metadata.verification;
  if (verification === 'fresh' || verification === 'stale' || verification === 'failed' || verification === 'unknown') accumulator.evidence.verification = { outcome: verification };
}

export function mergeOpenCodeEvidence(explicit: unknown, captured: OpenCodeEvidence): OpenCodeEvidence {
  const input = explicit && typeof explicit === 'object' && !Array.isArray(explicit) ? explicit as Record<string, unknown> : {};
  const existing = input as OpenCodeEvidence;
  return {
    ...(Array.isArray(existing.changedPaths) || captured.changedPaths !== undefined ? { changedPaths: [...new Set([...(existing.changedPaths ?? []), ...(captured.changedPaths ?? [])])].slice(0, MAX_ITEMS) } : {}),
    ...(Array.isArray(existing.errorSignatures) || captured.errorSignatures !== undefined ? { errorSignatures: [...new Set([...(existing.errorSignatures ?? []), ...(captured.errorSignatures ?? [])])].slice(0, MAX_ITEMS) } : {}),
    ...(Array.isArray(existing.commands) || captured.commands !== undefined ? { commands: [...(existing.commands ?? []), ...(captured.commands ?? [])].slice(-MAX_ITEMS) } : {}),
    ...(Array.isArray(existing.tests) || captured.tests !== undefined ? { tests: [...(existing.tests ?? []), ...(captured.tests ?? [])].slice(-MAX_ITEMS) } : {}),
    ...(existing.verification !== undefined || captured.verification !== undefined ? { verification: captured.verification ?? existing.verification } : {}),
  };
}
