import { z } from 'zod';
import { KiokukoError } from '../errors.js';
import type { TaskProfile } from './types.js';

export const PROFILE_MEMORY_POLICY = 'profile-memory-v1' as const;
export const PROFILE_MEMORY_MAX_CANDIDATES = 64;
export const PROFILE_MEMORY_HINT_CHARS = 4_096;
export const probeModeSchema = z.enum(['off', 'shadow', 'suggest', 'resolve']);
export type ProbeMode = z.infer<typeof probeModeSchema>;
const identifier = z.string().min(1).max(256);
const hash = z.string().regex(/^[0-9a-f]{64}$/u);
export const profileEvidenceSchema = z.strictObject({
  runId: identifier, sessionId: identifier, repositoryId: identifier,
  profileHash: hash, sourceHash: hash,
  rankingScore: z.number().int().min(1).max(3),
});
export type ProfileEvidence = z.infer<typeof profileEvidenceSchema>;
export const memoryResolutionSchema = z.strictObject({
  policyVersion: z.literal(PROFILE_MEMORY_POLICY), mode: probeModeSchema,
  status: z.enum(['skipped', 'complete', 'incomplete', 'revoked']),
  coverage: z.enum(['complete', 'partial']),
  baseHash: hash, resultHash: hash,
  adoptedRunId: identifier.nullable(),
  candidates: z.array(profileEvidenceSchema).max(PROFILE_MEMORY_MAX_CANDIDATES),
  reason: z.enum(['off', 'capability_unavailable', 'profile_complete', 'searched', 'unbound']),
  metrics: z.strictObject({
    queryCount: z.number().int().min(0).max(3),
    expandedProfiles: z.number().int().min(0).max(PROFILE_MEMORY_MAX_CANDIDATES),
    elapsedMs: z.number().finite().nonnegative(), truncated: z.boolean(),
  }),
}).superRefine((value, ctx) => {
  if (new Set(value.candidates.map(candidate => candidate.runId)).size !== value.candidates.length
    || (value.adoptedRunId !== null && (value.mode !== 'resolve' || value.status !== 'complete'
      || value.coverage !== 'complete' || value.metrics.truncated
      || !value.candidates.some(candidate => candidate.runId === value.adoptedRunId)))
    || (value.status === 'revoked' && (value.candidates.length !== 0 || value.adoptedRunId !== null))) {
    ctx.addIssue({ code: 'custom', message: 'Inconsistent profile memory resolution' });
  }
});
export type MemoryResolution = z.infer<typeof memoryResolutionSchema>;
export function parseMemoryResolution(value: unknown): MemoryResolution {
  const parsed = memoryResolutionSchema.safeParse(value);
  if (!parsed.success) throw new KiokukoError('INTEGRITY_ERROR', 'Stored profile memory resolution is invalid');
  return parsed.data;
}
export interface ProfileMemoryScope { workspace: string; repositoryId: string; repositoryRoot: string }
export interface ProfileMemoryOptions { scope: ProfileMemoryScope; mode: ProbeMode; capabilities?: unknown; signal?: AbortSignal }
export interface ProfileCandidate {
  evidence: ProfileEvidence;
  profile: TaskProfile;
  sources: Partial<Record<keyof TaskProfile, 'inferred' | 'client_supplied' | 'user_answer' | 'memory'>>;
  ready: boolean;
  completed: boolean;
}
export interface MemoryHint {
  field: keyof TaskProfile;
  value: string;
  reason: 'previous_example';
  source: ProfileEvidence & { originalSource: string };
  verification: 'current_source';
  untrusted: true;
}
export function readProfileMemoryMode(value: unknown = process.env.KIOKUKO_AKINATOR_MEMORY_MODE): ProbeMode {
  const parsed = probeModeSchema.safeParse(value ?? 'off');
  if (!parsed.success) throw new KiokukoError('VALIDATION_ERROR', 'KIOKUKO_AKINATOR_MEMORY_MODE must be off, shadow, suggest, or resolve');
  return parsed.data;
}
