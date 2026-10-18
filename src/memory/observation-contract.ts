import { DEFAULT_CONTEXT_CHARACTERS } from './context-budget.js';
import type { RelationDelivery } from './relation-delivery.js';
import * as z from 'zod/v4';
import { absoluteCwdSchema } from '../repository/cwd-schema.js';

const id = z.string().min(1).max(256).regex(/^[\w.:/-]+$/u);
const text = z.string().trim().max(2048);
export const observationOutcomeSchema = z.enum(['passed', 'failed', 'unknown']);
export const observationSchema = z.object({
  cwd: absoluteCwdSchema, eventId: id, sessionId: id,
  kind: z.enum(['compaction', 'completion', 'model_switch', 'complaint', 'praise']),
  summary: text.default(''), tags: z.array(z.string().trim().min(1).max(64)).max(20).default([]),
  outcome: observationOutcomeSchema.default('unknown'), verification: observationOutcomeSchema.default('unknown'),
  issue: text.optional(), prevention: text.optional(), fromModel: z.string().max(128).optional(), toModel: z.string().max(128).optional(),
  actions: z.array(z.object({ kind: z.enum(['inspect', 'edit', 'build', 'test', 'recover', 'explain', 'other']),
    outcome: observationOutcomeSchema.default('unknown'), summary: z.string().trim().max(512).default('') }).strict()).max(20).default([]),
  source: z.object({ producer: z.enum(['codex', 'agenticreplay', 'kiokuko-ai', 'kiokuko-dsh']),
    runId: id.optional(), eventIds: z.array(id).max(40).default([]),
    revision: z.number().int().nonnegative().default(0), tombstone: z.boolean().default(false) }).strict(),
}).strict().refine(value => value.source.tombstone || value.summary.length > 0, 'A live observation needs a public summary');
export const memoryContextSchema = z.object({ cwd: absoluteCwdSchema, query: z.string().max(500).default(''),
  tags: z.array(z.string().max(64)).max(20).default([]), sessionId: id.optional(), limit: z.number().int().min(1).max(50).default(10),
  maxContextChars: z.number().int().min(1).max(100_000).default(DEFAULT_CONTEXT_CHARACTERS) }).strict();
export const memoryImproveSchema = z.object({ cwd: absoluteCwdSchema, limit: z.number().int().min(1).max(200).default(100) }).strict();
export type MemoryObservation = z.infer<typeof observationSchema>;
export interface MemoryContextItem {
  workspace?: string;
  entryId: string; revision: number; kind: string; summary: string; tags: string[]; confidence: number;
  verification: 'passed' | 'failed' | 'unknown'; verificationProvenance: 'declared' | 'recorded' | 'unknown';
  actions?: Array<{ kind: string; outcome: string; summary: string }>; issue?: string; prevention?: string;
  sourceEventIds: string[]; scope: 'project' | 'global'; untrusted: true;
}
export interface MemoryContextResponse {
  relationDelivery?: RelationDelivery;
  characterCount?: number; truncated?: boolean;
  available: boolean; workMayContinue: true; entries: MemoryContextItem[];
  handoff: null | { sessionId: string; summary: string; tags: string[]; sourceEventIds: string[]; updatedAt: string; expiresAt: string };
  warnings: string[];
}

export interface MemoryRecordResponse {
  accepted: boolean; recorded: boolean; workMayContinue: true; warnings: string[];
  duplicate?: boolean; entryId?: string; sourceEventId?: string; sourceRevision?: number;
  saved?: number; withdrawn?: number; verification?: 'unknown'; untrusted?: true;
}
