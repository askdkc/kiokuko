import * as z from 'zod/v4';
import { KiokukoError } from '../errors.js';
const id = z.string().min(1).max(256).refine(v => v.trim() === v && !/\p{Cc}/u.test(v));
const text = z.string().trim().min(1).max(4000);
export const assuranceBase = {
  runId: id, requestId: id, expectedRevision: z.number().int().min(0), cwd: z.string().min(1).max(4096),
};
export const memoryReviewSchema = z.object({
  ...assuranceBase, deliveryId: id, entryId: id, entryRevision: z.number().int().min(1),
  decision: z.enum(['adopted', 'inapplicable', 'contradicted']), basis: text,
  invariant: text.optional(), counterexample: text.optional(), verification: text.optional(),
  evidenceIds: z.array(id).max(50).default([]),
}).strict().superRefine((v, ctx) => {
  if (v.decision === 'adopted') for (const key of ['invariant', 'counterexample', 'verification'] as const) {
    if (!v[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'Adoption requires an invariant, counterexample and verifier' });
  }
});
export const executionEvidenceSchema = z.object({
  ...assuranceBase, deliveryId: id.nullable(), execution: text,
  stateDigest: z.string().regex(/^[0-9a-f]{64}$/),
  outcome: z.enum(['passed', 'failed', 'skipped', 'unknown']), exitCode: z.number().int().nullable(),
}).strict().refine(v => v.outcome !== 'passed' || v.exitCode === 0, 'Passing evidence requires exit code zero');
export const memoryRefreshSchema = z.object({
  ...assuranceBase, capabilities: z.array(z.unknown()).optional(),
  changedPaths: z.array(z.string().min(1).max(500)).max(100).default([]),
  errorSignatures: z.array(z.string().min(1).max(1000)).max(50).default([]),
  maxContextChars: z.number().int().min(1).max(100000).optional(),
}).strict().refine(v => v.changedPaths.length + v.errorSignatures.length > 0, 'Refresh requires new retrieval signals');
export function parseAssurance<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new KiokukoError('VALIDATION_ERROR', 'Task assurance input is invalid');
  return result.data;
}
