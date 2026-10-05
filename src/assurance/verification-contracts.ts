import * as z from 'zod/v4';
import { assuranceBase } from './contracts.js';

const text = z.string().trim().min(1).max(1000).refine(value => !/\p{Cc}/u.test(value));
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u);
const reference = z.string().url().max(2000).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
}, 'Use an HTTPS job/run reference without credentials or query parameters');
export const verificationCheckSchema = z.object({ id, target: text, expected: text, method: text }).strict();
export const verificationDefineSchema = z.object({
  ...assuranceBase, reason: text,
  checks: z.array(verificationCheckSchema).min(1).max(100),
}).strict().refine(input => new Set(input.checks.map(check => check.id)).size === input.checks.length, 'Check IDs must be unique');
export const verificationRecordSchema = z.object({
  ...assuranceBase, contractVersion: z.number().int().positive(), checkId: id, target: text,
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('local'), evidenceId: z.string().min(1).max(256) }).strict(),
    z.object({ kind: z.literal('ci'), commit: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u), runUrl: reference, jobUrl: reference,
      conclusion: z.enum(['success', 'failure', 'cancelled', 'timed_out', 'skipped', 'unknown']),
    }).strict(),
  ]),
}).strict();
export type VerificationCheck = z.infer<typeof verificationCheckSchema>;
export type VerificationSource = z.infer<typeof verificationRecordSchema>['source'];
