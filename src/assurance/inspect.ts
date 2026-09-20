import * as z from 'zod/v4';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KiokukoError } from '../errors.js';
import { parseAssurance } from './contracts.js';
export const inspectTaskSchema = z.object({
  cwd: z.string().min(1).max(4096), operation: z.enum(['read', 'files', 'status', 'skill']),
  path: z.string().min(1).max(500).optional(),
}).strict();
/** Preparation-only inspection: fixed operations, no shell parser or executable supplied by the model. */
export function inspectTask(raw: unknown) {
  const input = parseAssurance(inspectTaskSchema, raw);
  const root = realpathSync(execFileSync('git', ['-C', realpathSync(input.cwd), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 }).trim());
  if (input.operation === 'files' || input.operation === 'status') {
    const args = input.operation === 'files' ? ['ls-files', '--cached', '--others', '--exclude-standard'] : ['status', '--short'];
    return { text: execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 512000 }) };
  }
  const base = input.operation === 'skill' ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills') : root;
  const name = input.path ?? '';
  if (!name || path.isAbsolute(name) || name.split(/[\\/]/).includes('..') || name.split(/[\\/]/).some(p => p === '.git' || p === '.env')) throw new KiokukoError('VALIDATION_ERROR', 'Inspection path is invalid');
  const resolved = realpathSync(path.join(base, name));
  if (!resolved.startsWith(realpathSync(base) + path.sep) || !statSync(resolved).isFile() || statSync(resolved).size > 256000) throw new KiokukoError('VALIDATION_ERROR', 'Inspection exceeds its file boundary');
  return { text: readFileSync(resolved, 'utf8') };
}
