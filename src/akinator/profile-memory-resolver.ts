import type { ProfileCandidate, ProbeMode } from './memory-probe-types.js';
import type { TaskProfile } from './types.js';

/** Bounded literal identifiers, never a query language or instructions. */
export function profileSignals(text: string): string[] {
  return boundedProfileSignals(text).signals;
}

export function boundedProfileSignals(text: string): { signals: string[]; truncated: boolean } {
  const values = [...new Set((text.slice(0, 16_384).match(/[\p{L}\p{N}_./-]+/gu) ?? [])
    .map(value => value.replace(/^\.\//u, '')))];
  const usable = values.filter(value => value.length > 0 && value.length <= 256);
  return { signals: usable.slice(0, 32), truncated: text.length > 16_384 || usable.length > 32 || values.some(value => value.length > 256) };
}

/** Pure adoption rule. Filesystem validation is a separate, injected fact. */
export function resolveProfileTarget(input: {
  profile: TaskProfile; mode: ProbeMode; complete: boolean;
  candidates: readonly ProfileCandidate[]; verifiedTargets: ReadonlySet<string>;
}): { profile: TaskProfile; adoptedRunId: string | null } {
  const unchanged = { profile: { ...input.profile }, adoptedRunId: null };
  if (input.mode !== 'resolve' || input.profile.target !== null || !input.complete) return unchanged;
  const targets = new Set(input.candidates.map(candidate => candidate.profile.target).filter(Boolean));
  if (targets.size !== 1) return unchanged;
  const eligible = input.candidates.find(candidate => candidate.ready && candidate.completed
    && candidate.profile.target !== null && input.verifiedTargets.has(candidate.profile.target)
    && (candidate.sources.target === 'client_supplied' || candidate.sources.target === 'user_answer'));
  if (!eligible) return unchanged;
  return { profile: { ...input.profile, target: eligible.profile.target }, adoptedRunId: eligible.evidence.runId };
}
