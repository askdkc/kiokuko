import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { KiokukoError } from '../errors.js';

export async function readRegularFile(filePath: string): Promise<{ content: string; mode: number } | undefined> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) throw new KiokukoError('SECURITY_REJECTION', `Refusing to follow symlink: ${filePath}`);
    if (!info.isFile()) throw new KiokukoError('VALIDATION_ERROR', `Expected a regular file: ${filePath}`);
    return { content: await readFile(filePath, 'utf8'), mode: info.mode & 0o777 };
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function atomicWriteText(filePath: string, content: string, mode = 0o644): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode });
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new KiokukoError('PARTIAL_FAILURE', `Unable to atomically write ${filePath}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}
