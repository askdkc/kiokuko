import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { KiokukoError } from '../errors.js';

/** Hash the Git-visible source, tests and configuration; never persist file contents. */
export function repositoryStateDigest(root: string): string {
  const canonical = realpathSync(root);
  const gitRoot = execFileSync('git', ['-C', canonical, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 }).trim();
  if (realpathSync(gitRoot) !== canonical) throw new KiokukoError('CONFLICT', 'Evidence requires the canonical repository root');
  const names = execFileSync('git', ['-C', canonical, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  const configuration = ['.env', '.env.local', '.codex/config.toml', '.codex/hooks.json', '.kiokuko.json'].filter(name => existsSync(path.join(canonical, name)));
  const files = [...new Set([...names.split('\0').filter(Boolean), ...configuration])].sort();
  if (files.length > 20000) throw new KiokukoError('VALIDATION_ERROR', 'Repository snapshot exceeds its file budget');
  const hash = createHash('sha256').update('kiokuko-state-v1\0');
  let bytes = 0;
  for (const file of files) {
    const full = path.resolve(canonical, file);
    if (!full.startsWith(canonical + path.sep)) throw new KiokukoError('INTEGRITY_ERROR', 'Snapshot path escapes the repository');
    hash.update(file).update('\0');
    let stat;
    try { stat = lstatSync(full); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { hash.update('deleted\0'); continue; }
      throw error;
    }
    if (!stat.isFile() || realpathSync(full) !== full) throw new KiokukoError('VALIDATION_ERROR', 'Snapshot cannot verify symlinks or non-regular files');
    bytes += stat.size;
    if (bytes > 64 * 1024 * 1024) throw new KiokukoError('VALIDATION_ERROR', 'Repository snapshot exceeds its byte budget');
    hash.update(String(stat.mode)).update('\0').update(readFileSync(full)).update('\0');
  }
  return hash.digest('hex');
}
