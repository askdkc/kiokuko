import { createHash } from 'node:crypto';
const treeHash = files => createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a],[b]) => a.localeCompare(b)))).digest('hex');
/** Input must originate at an exclusive executor barrier, not the CLI receiver.
 * Authentication of that producer belongs to the evidence bundle verifier. */
export function checkpointErrors(checkpoints, authority) {
  const errors = []; const ids = new Set(); let sequence = 0;
  if (authority !== 'executor-barrier-v1') errors.push('Execution barrier unavailable');
  if (!Array.isArray(checkpoints) || !checkpoints.length) return [...errors,'Execution checkpoints missing'];
  for (const item of checkpoints) {
    if (!Number.isSafeInteger(item.sequence) || item.sequence <= sequence || !item.commandId || ids.has(item.commandId)) errors.push('Missing, duplicate or reversed checkpoint identity');
    sequence = item.sequence; ids.add(item.commandId);
    if (item.barrier !== 'exclusive-persist-before-ack' || item.acknowledged !== true || item.treeHash !== treeHash(item.files ?? {})
      || !Number.isInteger(item.exitCode) || item.signal !== null || typeof item.command !== 'string') errors.push('Incomplete or non-atomic checkpoint');
  }
  return errors;
}
