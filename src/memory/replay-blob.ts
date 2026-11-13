import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';

const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const MAX_STORED_GZIP_BYTES = MAX_BLOB_BYTES + 64 * 1024;
const decompress = promisify(gunzip);

/** Read one regular run-local file, bounded even if it grows after stat.
 * An opened raw file remains usable when compact unlinks its pathname. */
async function readStoredBlob(file: string, directory: string, maximum: number): Promise<Buffer> {
  const canonical = await realpath(file);
  if (!canonical.startsWith(directory + path.sep)) throw new Error('replay_scope_mismatch');
  // Avoid blocking on a FIFO and reject a final-component symlink swapped after realpath.
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) throw new Error('replay_source_bound');
    const buffer = Buffer.allocUnsafe(maximum + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error('replay_source_bound');
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** Return only integrity-checked, uncompressed bytes. directory is the canonical
 * run directory. The caller charges every reference against its aggregate budget.
 * Only a missing raw file permits gzip fallback; validation errors never do. */
export async function readReplayBlob(directory: string, digest: string, declaredBytes: number, remainingBytes: number): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/u.test(digest) || !Number.isSafeInteger(declaredBytes) || declaredBytes < 0
    || !Number.isSafeInteger(remainingBytes) || remainingBytes < 0) throw new Error('replay_blob_invalid');
  if (declaredBytes > MAX_BLOB_BYTES) throw new Error('replay_source_bound');
  if (declaredBytes > remainingBytes) throw new Error('replay_blob_budget_exceeded');
  const file = path.join(directory, 'blobs', digest.slice(0, 2), digest);
  let bytes: Buffer;
  try {
    bytes = await readStoredBlob(file, directory, MAX_BLOB_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const stored = await readStoredBlob(file + '.gz', directory, MAX_STORED_GZIP_BYTES);
    try {
      // Node requires a positive limit; zero-length declarations are checked below.
      bytes = await decompress(stored, { maxOutputLength: Math.max(1, Math.min(MAX_BLOB_BYTES, remainingBytes, declaredBytes)) });
    } catch (error) {
      // Never expose zlib messages or recorded data. Concatenated members share this limit.
      throw new Error((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE'
        ? 'replay_source_bound' : 'replay_blob_gzip_invalid');
    }
  }
  if (bytes.length !== declaredBytes || createHash('sha256').update(bytes).digest('hex') !== digest) {
    throw new Error('replay_blob_integrity');
  }
  return bytes;
}
