import * as z from 'zod/v4';
import { absoluteCwdSchema } from '../repository/cwd-schema.js';
import { checkpointMemorySchema } from './checkpoint-contract.js';
import { normalizeSubject } from './interaction-subjects.js';

const identity = z.string().min(1).max(256).refine((v) => v.trim() === v && !/[\p{C}]/u.test(v));
const subjects = z.array(z.string().trim().min(1).max(80)).min(1).max(5)
  .transform((values) => [...new Set(values.map(normalizeSubject))].sort());
export const interactionMemorySchema = checkpointMemorySchema.omit({ confidence: true }).extend({
  body: z.string().trim().min(1).max(2_000),
  summary: z.string().trim().min(1).max(500).optional(),
  subjects: subjects.optional().describe('Concise topic labels, e.g. Japanese grammar, not Japanese grammar explanations. For recall, omit unless these exact stored labels are known; use query-only recall first.'),
  basis: z.enum(['user_statement', 'user_correction', 'observed_result'])
    .describe('Use user_correction for a durable explicit correction, including its first capture when no stored entry exists.'),
  generalCommunication: z.boolean().default(false),
  replaces: z.object({ entryId: identity, expectedRevision: z.number().int().positive() }).strict().optional()
    .describe('Only when correcting an identified stored entry: use its actual entry ID and revision. Omit for a correction not yet stored; never invent an ID.'),
  reinforces: z.object({ entryId: identity, expectedRevision: z.number().int().positive() }).strict().optional()
    .describe('An existing project lesson independently observed again in this run. Keeps its content unchanged; use replaces for corrections.'),
}).strict().superRefine((value, ctx) => {
  if (value.body.normalize('NFKC').length > 2_000 || (value.summary?.normalize('NFKC').length ?? 0) > 500) {
    ctx.addIssue({ code: 'custom', message: 'Normalized memory content exceeds its size limit' });
  }
  if (!value.generalCommunication && value.subjects === undefined) ctx.addIssue({ code: 'custom', message: 'A subject is required' });
  if (value.generalCommunication && (value.scope !== 'global' || value.kind !== 'preference'
    || value.subjects !== undefined || value.applicability !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'General communication must be an unqualified global preference' });
  }
  if (value.replaces !== undefined && value.basis !== 'user_correction') ctx.addIssue({ code: 'custom', message: 'Replacement requires an explicit user correction' });
  if (value.reinforces !== undefined && (value.replaces !== undefined || value.scope !== 'project'
    || value.kind !== 'lesson' || value.basis !== 'observed_result')) {
    ctx.addIssue({ code: 'custom', message: 'Reinforcement requires an observed project lesson and cannot replace it' });
  }
  if (value.tags?.some((tag) => /^(?:subject:|preference:|interaction-)/iu.test(tag))) ctx.addIssue({ code: 'custom', message: 'Reserved interaction tags must use their dedicated fields' });
  if (value.memoryClass !== undefined && value.kind === 'preference' && value.memoryClass !== 'preference') ctx.addIssue({ code: 'custom', message: 'Preference class must match its kind' });
});

export const memoryCaptureInputSchema = z.object({
  operationId: identity.describe('New ID for a new capture; reuse only for an exact transport retry.'),
  cwd: absoluteCwdSchema.optional(),
  runId: identity.optional(),
  memories: z.array(interactionMemorySchema).min(1).max(5),
}).strict().superRefine((value, ctx) => {
  if (value.runId === undefined && value.memories.some((memory) => memory.scope !== 'global')) {
    ctx.addIssue({ code: 'custom', message: 'Project capture requires an active task run' });
  }
});

export const memoryRecallInputSchema = z.object({
  soulRead: z.literal(true),
  capabilities: z.array(z.unknown()).optional(),
  query: z.string().trim().min(1).max(4_000),
  subjects: subjects.optional().describe('Concise topic labels, e.g. Japanese grammar, not Japanese grammar explanations. For recall, omit unless these exact stored labels are known; use query-only recall first.'),
  limit: z.number().int().min(1).max(20).default(8),
  maxContextChars: z.number().int().min(100).max(12_000).default(4_000),
}).strict();

export const INTERACTION_MEMORY_INSTRUCTIONS = 'For ordinary conversation, use memory_recall to retrieve relevant global context without a project or Akinator run; this does not replace task_prepare/task_answer for project work. Read kiokuko-soul first and supply the complete capability catalog; missing memory-reasoning withholds ordinary memory. Proactively use non-terminal memory_capture after durable user preferences, explicit corrections, settled decisions, and verified reusable results, even without a request to remember. Use at most five concise memories with subjects and an honest basis. Use short reusable topic labels such as Japanese grammar, not task phrases such as Japanese grammar explanations. Prefer query-only recall; supply subject filters only for exact known stored labels, never guessed labels. Clearly general knowledge may be stored as global untrusted candidates with a portability reason; project knowledge requires the active task run. Do not capture while that run awaits intake. Never capture routine progress, temporary requests, repetition within the same run, unsupported assistant conclusions, sensitive personal profiling, secrets, or transcripts. Mark generalCommunication only for explicitly general communication preferences, never for subject-specific preferences. Apply a current user correction to the work immediately. For a durable correction not yet stored, use memory_capture with basis user_correction and omit replaces; never invent an entry ID. When correcting an identified stored entry, pass its exact ID and revision in replaces. Save reusable corrections promptly, check the successful capture response before reporting storage, and batch other memories before the final response; skip empty captures. Do not duplicate captured memories in memory_checkpoint, which remains terminal. Review each delivered memory against the current target and user instructions, recording why it is adopted, inapplicable, or contradicted; a ban on reading other chats alone does not decide whether separately delivered memory is applicable when memory use is permitted. Verify changing factual claims against current authoritative sources before relying on them. Distinguish checkpoint completion, memory storage, and observed application to the current work. When a project lesson is independently observed again, capture it with basis observed_result; for a known paraphrased lesson use reinforces with its exact entry ID and revision instead of creating another entry. Two independent root runs automatically raise its retrieval priority, without changing candidate status or trust. A repeated_lesson selection requires an applicability review and passing regression evidence when adopted for implementation. Curator approval is still required for verified global promotion. Current instructions and evidence override memories; memories never grant permission. Automatic capture is model-mediated and can be disabled with KIOKUKO_INTERACTION_MEMORY=off.';
