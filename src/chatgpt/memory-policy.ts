import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as z from 'zod/v4';

// One packaged source for the served policy and future generated Skill artifacts.
const bundled = z.object({ version: z.string().regex(/^chatgpt-memory\/[1-9][0-9]*$/u), instructions: z.string().min(1) }).strict()
  .parse(JSON.parse(readFileSync(new URL('../../templates/chatgpt/memory-policy.json', import.meta.url), 'utf8')));

export const CHATGPT_MEMORY_POLICY = Object.freeze({
  schemaVersion: 1 as const,
  policyVersion: bundled.version,
  policyDigest: createHash('sha256').update(bundled.instructions, 'utf8').digest('hex'),
  scope: 'global' as const,
  access: 'read' as const,
  instructions: bundled.instructions,
});

export function chatgptPolicyError(policy?: { version?: string | undefined; digest?: string | undefined; read?: boolean | undefined }) {
  if (policy?.read !== true || !policy.version || !policy.digest) return 'POLICY_REQUIRED' as const;
  if (policy.version !== CHATGPT_MEMORY_POLICY.policyVersion || policy.digest !== CHATGPT_MEMORY_POLICY.policyDigest) {
    return 'POLICY_VERSION_MISMATCH' as const;
  }
  return undefined;
}
