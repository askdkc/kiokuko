import type { SqliteDatabase } from '../db/adapter.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { turnReceiptSchema, validateUserTurnReceipt, type ExpectedUserTurn } from '../agenticreplay/turn-receipt.js';

/** Durable receipt identity, not a completion assertion or a memory approval. */
export function retainTurnReceipt(db: SqliteDatabase, root: string, value: unknown, expected: ExpectedUserTurn): string {
  const parsed = turnReceiptSchema.safeParse(value);
  if (!parsed.success) throw new Error('receipt_schema_invalid');
  const receipt = parsed.data;
  if (receipt.source !== expected.source || receipt.sessionId !== expected.sessionId || receipt.turnId !== expected.turnId) {
    throw new Error('receipt_identity_mismatch');
  }
  let reason = 'receipt_verified_identity';
  try { validateUserTurnReceipt(receipt, expected); }
  catch (error) { reason = (error as Error).message; }
  const digest = canonicalContentHash(receipt);
  db.prepare(`INSERT INTO memory_capture_receipts
    (receipt_id, repository_root, source, session_id, turn_id, body_digest, receipt_json, reason, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(receipt_id) DO NOTHING`)
    .run(receipt.receiptId, root, receipt.source, receipt.sessionId, receipt.turnId, digest,
      JSON.stringify(receipt), reason, new Date().toISOString());
  const row = db.prepare('SELECT body_digest, repository_root FROM memory_capture_receipts WHERE receipt_id = ?')
    .get<{ body_digest: string; repository_root: string }>(receipt.receiptId);
  if (row?.body_digest !== digest || row.repository_root !== root) throw new Error('receipt_conflict');
  return reason;
}
