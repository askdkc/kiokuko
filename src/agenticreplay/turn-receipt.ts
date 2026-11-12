import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

// Mirrors AgenticReplay's schema/turn-receipt.schema.json, schemaVersion 1.
// The installed recorder may predate this capability. Never infer it from version.
const id = z.string().regex(/^[\w-]{1,128}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const turnReceiptSchema = z.object({
  schemaVersion: z.literal(1), receiptId: digest,
  source: z.enum(['codex-runtime', 'chatgpt-host']), sessionId: id, turnId: id,
  branchId: id.nullable(), scope: z.enum(['user', 'background', 'subagent', 'unknown']),
  requestIds: z.array(id).max(32).refine(ids => new Set(ids).size === ids.length),
  identityComplete: z.boolean(), outcome: z.enum(['completed', 'interrupted', 'failed']),
  evidence: z.literal('host-notification'),
  recording: z.object({ runId: z.string().regex(/^run_[a-f0-9]{6,32}$/u),
    directory: z.string().min(1).max(4096), eventsSha256: digest }).strict(),
  capture: z.enum(['complete', 'incomplete']),
}).strict().refine(r => !r.identityComplete || (r.branchId !== null && r.scope !== 'unknown' && r.requestIds.length > 0));
export type TurnReceipt = z.infer<typeof turnReceiptSchema>;
export type ExpectedUserTurn = Pick<TurnReceipt, 'source' | 'sessionId' | 'turnId' | 'branchId'>;

/** Integrity is not authenticity. Call only with a receipt read from a trusted
 * recorder transport and an independently host-bound expected identity.
 * Never register this function as a model-facing receipt submission tool. */
export function validateUserTurnReceipt(value: unknown, expected: ExpectedUserTurn): TurnReceipt {
  const parsed = turnReceiptSchema.safeParse(value);
  if (!parsed.success) throw new Error('receipt_schema_invalid');
  const r = parsed.data;
  if (r.source !== expected.source || r.sessionId !== expected.sessionId || r.turnId !== expected.turnId
    || r.branchId !== expected.branchId) throw new Error('receipt_identity_mismatch');
  if (!r.identityComplete || r.branchId === null || r.scope !== 'user') throw new Error('receipt_user_scope_unproven');
  if (r.outcome !== 'completed') throw new Error('receipt_completion_missing');
  if (r.capture !== 'complete') throw new Error('receipt_recording_incomplete');
  return r;
}

export async function verifyReceiptRecording(rootInput: string, receipt: TurnReceipt): Promise<string> {
  const root = await realpath(rootInput);
  const runs = path.join(root, '.agenticreplay', 'runs');
  if (await realpath(runs) !== runs || !path.isAbsolute(receipt.recording.directory)) throw new Error('receipt_recording_scope');
  const directory = await realpath(receipt.recording.directory);
  if (!directory.startsWith(runs + path.sep)) throw new Error('receipt_recording_scope');
  const read = async (name: string, limit: number) => {
    const file = path.join(directory, name);
    if (await realpath(file) !== file) throw new Error('receipt_recording_scope');
    const info = await stat(file);
    if (!info.isFile() || info.size > limit) throw new Error('receipt_recording_bound');
    const bytes = await readFile(file);
    if (bytes.length > limit) throw new Error('receipt_recording_bound');
    return bytes;
  };
  const bytes = await read('events.jsonl', 8 * 1024 * 1024);
  if (createHash('sha256').update(bytes).digest('hex') !== receipt.recording.eventsSha256) throw new Error('receipt_recording_integrity');
  const manifest = JSON.parse((await read('manifest.json', 65536)).toString('utf8'));
  if (manifest.run_id !== receipt.recording.runId || typeof manifest.cwd !== 'string' || await realpath(manifest.cwd) !== root
    || manifest.integrity?.events_sha256 !== receipt.recording.eventsSha256 || manifest.capture?.status !== 'complete') {
    throw new Error('receipt_recording_integrity');
  }
  return directory;
}
