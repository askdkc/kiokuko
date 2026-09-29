import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { KiokukoError } from '../errors.js';

interface SnapshotBudget { files: number; bytes: number }

/** Hash the Git-visible source, tests and configuration; never persist file contents. */
export function repositoryStateDigest(root: string): string {
  return snapshotRepository(root, { files: 0, bytes: 0 }, 0);
}

function snapshotRepository(root: string, budget: SnapshotBudget, depth: number): string {
  if (depth > 16) throw new KiokukoError('VALIDATION_ERROR', 'Repository snapshot exceeds its submodule depth budget');
  const canonical = realpathSync(root);
  const gitRoot = execFileSync('git', ['-C', canonical, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 }).trim();
  if (realpathSync(gitRoot) !== canonical) throw new KiokukoError('CONFLICT', 'Evidence requires the canonical repository root');
  const names = execFileSync('git', ['-C', canonical, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  const index = execFileSync('git', ['-C', canonical, 'ls-files', '--stage', '-z'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  const gitlinks = new Map<string, string>();
  for (const row of index.split('\0')) {
    const separator = row.indexOf('\t');
    if (separator < 0) continue;
    const match = /^160000 ([0-9a-f]{40,64}) 0$/u.exec(row.slice(0, separator));
    if (match) gitlinks.set(row.slice(separator + 1), match[1]!);
  }
  const configuration = ['.env', '.env.local', '.codex/config.toml', '.codex/hooks.json', '.kiokuko.json'].filter(name => existsSync(path.join(canonical, name)));
  const files = [...new Set([...names.split('\0').filter(Boolean), ...configuration])].sort();
  budget.files += files.length;
  if (budget.files > 20000) throw new KiokukoError('VALIDATION_ERROR', 'Repository snapshot exceeds its file budget');
  const hash = createHash('sha256').update('kiokuko-state-v1\0');
  for (const file of files) {
    const full = path.resolve(canonical, file);
    if (!full.startsWith(canonical + path.sep)) throw new KiokukoError('INTEGRITY_ERROR', 'Snapshot path escapes the repository');
    hash.update(file).update('\0');
    let stat;
    try { stat = lstatSync(full); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { hash.update('deleted\0'); continue; }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(full);
      const resolvedTarget = realpathSync(full);
      if (!resolvedTarget.startsWith(canonical + path.sep)) throw new KiokukoError('VALIDATION_ERROR', 'Snapshot symlink escapes the repository');
      const targetStat = lstatSync(resolvedTarget);
      if (!targetStat.isFile()) throw new KiokukoError('VALIDATION_ERROR', 'Snapshot symlink target is not a regular file');
      budget.bytes += Buffer.byteLength(target) + targetStat.size;
      if (budget.bytes > 64 * 1024 * 1024) throw new KiokukoError('VALIDATION_ERROR', 'Repository snapshot exceeds its byte budget');
      hash.update(String(stat.mode)).update('\0').update(target).update('\0');
      hash.update(String(targetStat.mode)).update('\0').update(readFileSync(resolvedTarget)).update('\0');
      continue;
    }
    if (stat.isDirectory() && gitlinks.has(file) && realpathSync(full) === full) {
      hash.update('gitlink\0').update(gitlinks.get(file)!).update('\0');
      hash.update(snapshotRepository(full, budget, depth + 1)).update('\0');
      continue;
    }
    if (!stat.isFile() || realpathSync(full) !== full) throw new KiokukoError('VALIDATION_ERROR', 'Snapshot cannot verify non-regular files');
    budget.bytes += stat.size;
    if (budget.bytes > 64 * 1024 * 1024) throw new KiokukoError('VALIDATION_ERROR', 'Repository snapshot exceeds its byte budget');
    hash.update(String(stat.mode)).update('\0').update(readFileSync(full)).update('\0');
  }
  return hash.digest('hex');
}
