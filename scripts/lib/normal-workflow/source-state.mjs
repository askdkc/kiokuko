import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';
import { hash } from './oracle.mjs';

export function sourceFingerprint(root) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: root, encoding: 'utf8', timeout: 10000 }).split('\0').filter(Boolean).sort();
  return hash(JSON.stringify(files.map(file => {
    const location = path.join(root, file);
    let stat;
    try { stat = lstatSync(location); }
    catch (error) { if (error.code === 'ENOENT') return [file, 'missing']; throw error; }
    return [file, stat.mode, stat.isSymbolicLink() ? readlinkSync(location) : stat.isFile() ? hash(readFileSync(location)) : 'directory'];
  })));
}
