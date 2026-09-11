import type { BigIntStats } from 'node:fs';
import { lstat, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  assertAtomicCleanupComplete, assertFileExpectation, atomicWriteTextIfUnchanged,
  readDirectoryIdentity, readRegularFile, unlinkRegularFileIfUnchanged,
  type FileExpectation, type FileIdentity,
} from '../agent-file/atomic-write.js';
import { KiokukoError } from '../errors.js';

export interface UninstallFileResult {
  path: string;
  action: 'deleted' | 'updated' | 'preserved';
  reason?: string;
}

export interface TextRemoval {
  path: string;
  content: string | undefined;
  expectation: FileExpectation;
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Reject linked ancestors as well as linked targets before traversing any directory. */
export async function safeStat(target: string): Promise<BigIntStats | undefined> {
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let cursor = root;
  let info: BigIntStats | undefined;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try { info = await lstat(cursor, { bigint: true }); }
    catch (error) { if (isMissing(error)) return undefined; throw error; }
    if (info.isSymbolicLink()) throw new KiokukoError('SECURITY_REJECTION', `Uninstall refuses a symbolic link: ${cursor}`);
  }
  return info;
}

export async function planTextRemoval(
  target: string,
  render: (source: string) => string | undefined,
): Promise<TextRemoval | undefined> {
  const absolute = path.resolve(target);
  const filesystemRoot = path.parse(absolute).root;
  const containmentRoot = path.join(filesystemRoot, absolute.slice(filesystemRoot.length).split(path.sep)[0]!);
  await safeStat(target);
  const original = await readRegularFile(target, { containmentRoot });
  if (original === undefined) return undefined;
  const content = render(original.content);
  if (content === original.content) return undefined;
  const parent = await readDirectoryIdentity(path.dirname(target));
  if (parent === undefined) throw new KiokukoError('CONFLICT', `Uninstall directory disappeared: ${target}`);
  return {
    path: target,
    content,
    expectation: { expected: original, expectedParentDirectory: parent, containmentRoot },
  };
}

export async function applyTextRemoval(file: TextRemoval): Promise<void> {
  const result = file.content === undefined
    ? await unlinkRegularFileIfUnchanged(file.path, file.expectation)
    : await atomicWriteTextIfUnchanged(file.path, file.content, file.expectation, file.expectation.expected!.mode);
  assertAtomicCleanupComplete(result);
}

export async function assertTextRemovals(files: readonly TextRemoval[]): Promise<void> {
  for (const file of files) await assertFileExpectation(file.path, file.expectation);
}

export interface DataFileRemoval { path: string; original: BigIntStats }
export interface EmptyDirectoryRemoval { path: string; identity: FileIdentity }

/** Inventory only an explicitly owned subtree; never walk home or a shared data root. */
export async function inventoryOwnedTree(
  target: string,
  files: DataFileRemoval[],
  directories: EmptyDirectoryRemoval[],
  depth = 0,
): Promise<void> {
  if (files.length + directories.length > 20_000 || depth > 32) throw new KiokukoError('VALIDATION_ERROR', 'Uninstall file inventory limit exceeded');
  const info = await safeStat(target);
  if (info === undefined) return;
  if (info.isFile()) { files.push({ path: target, original: info }); return; }
  if (!info.isDirectory()) throw new KiokukoError('SECURITY_REJECTION', `Unsupported uninstall target: ${target}`);
  directories.push({ path: target, identity: { device: info.dev, inode: info.ino } });
  for (const name of (await readdir(target)).sort()) await inventoryOwnedTree(path.join(target, name), files, directories, depth + 1);
}

function sameDataFile(actual: BigIntStats | undefined, original: BigIntStats, renamed = false): boolean {
  return actual !== undefined && actual.isFile() && actual.dev === original.dev && actual.ino === original.ino
    && actual.size === original.size && actual.mtimeNs === original.mtimeNs
    && (renamed || actual.ctimeNs === original.ctimeNs);
}

export async function assertDataFiles(files: readonly DataFileRemoval[]): Promise<void> {
  for (const file of files) {
    if (!sameDataFile(await safeStat(file.path), file.original)) throw new KiokukoError('CONFLICT', `Uninstall data changed after planning: ${file.path}`);
  }
}

/** Validate a quarantined binary file before unlinking; never decode models or SQLite as text. */
export async function removeDataFile(file: DataFileRemoval): Promise<void> {
  await assertDataFiles([file]);
  const quarantine = `${file.path}.kiokuko-uninstall-${randomUUID()}`;
  await rename(file.path, quarantine);
  if (!sameDataFile(await safeStat(quarantine), file.original, true)) {
    throw new KiokukoError('CONFLICT', `Uninstall target changed; preserved for recovery at ${quarantine}`);
  }
  await unlink(quarantine);
}

/** Remove empty owned directories only. New or user-owned contents are left intact. */
export async function removeEmptyDirectories(directories: readonly EmptyDirectoryRemoval[]): Promise<UninstallFileResult[]> {
  const results: UninstallFileResult[] = [];
  const unique = new Map(directories.map(directory => [directory.path, directory]));
  for (const directory of [...unique.values()].sort((a, b) => b.path.length - a.path.length)) {
    const actual = await safeStat(directory.path);
    if (actual === undefined) continue;
    if (!actual.isDirectory() || actual.dev !== directory.identity.device || actual.ino !== directory.identity.inode) {
      throw new KiokukoError('CONFLICT', `Uninstall directory changed: ${directory.path}`);
    }
    try {
      await rmdir(directory.path);
      results.push({ path: directory.path, action: 'deleted' });
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'ENOTEMPTY' || error.code === 'EEXIST')) {
        results.push({ path: directory.path, action: 'preserved', reason: 'contains other files' });
      } else throw error;
    }
  }
  return results;
}
