import { createHash } from 'node:crypto';
import { PACKAGE_VERSION } from '../package-version.js';
import * as z from 'zod/v4';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KiokukoError } from '../errors.js';
import { parseAssurance } from './contracts.js';
import { logicalSkillName, INTEGRATION_CONTRACT, STANDARD_SKILL_MANIFESTS } from '../setup/standard-skills.js';

const inspectionFailures = {
  skill: ['VALIDATION_ERROR', 'For bundled Skill reads, omit path to read kiokuko-soul, or pass a Skill name such as kiokuko-soul. References use skill-name/references/file.md. Installed client paths are not bundled paths.'],
  path: ['VALIDATION_ERROR', 'Use a repository-relative file path or an absolute path inside the repository. Parent traversal, .git and .env are excluded.'],
  boundary: ['VALIDATION_ERROR', 'Inspection requires a regular file inside its allowed directory, at most 256000 bytes. Symlinks must stay inside that directory.'],
  missing: ['NOT_FOUND', 'Inspection file was not found. Use operation files to list repository paths, or omit path with operation skill to read kiokuko-soul.'],
  repository: ['VALIDATION_ERROR', 'Repository inspection requires an existing Git checkout. Bundled Skill reads use operation skill and need no checkout.'],
} as const;

/** Only fixed recovery text is safe to expose through MCP; never echo filesystem errors. */
export class TaskInspectionError extends KiokukoError {
  constructor(readonly reason: keyof typeof inspectionFailures) {
    const [code, message] = inspectionFailures[reason];
    super(code, message);
  }
}

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../skills');
export const inspectTaskSchema = z.object({
  cwd: z.string().min(1).max(4096), operation: z.enum(['read', 'files', 'status', 'skill', 'diff']),
  scope: z.enum(['auto', 'staged', 'working-tree']).optional().describe('Diff only. Auto (default) prefers staged changes, otherwise working-tree.'),
  path: z.string().min(1).max(4096).optional().describe('Skill: omit for kiokuko-soul, or use its name; references use skill-name/references/file.md. Read: repository-relative or in-repository absolute file path.'),
}).strict().refine(input => input.scope === undefined || input.operation === 'diff', { message: 'scope is only valid for diff' });

function bundledSkillPath(input: string | undefined): string {
  let name = input ?? 'kiokuko-soul';
  if (name.split(/[\\/]/u).includes('..')) throw new TaskInspectionError('skill');
  if (path.isAbsolute(name)) name = path.relative(skillRoot, name);
  name = name.replaceAll('\\', '/').replace(/^skills\//u, '');
  // Normalize representation before the fixed alias lookup. Do not collapse empty
  // segments, decode URLs or resolve parent/dot selectors as filesystem paths.
  const parts = name.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new TaskInspectionError('skill');
  parts[0] = logicalSkillName(parts[0]!);
  name = parts.join('/');
  const manifest = STANDARD_SKILL_MANIFESTS.find(skill => name === skill.name || name.startsWith(`${skill.name}/`));
  if (!manifest) throw new TaskInspectionError('skill');
  if (name === manifest.name) name += '/SKILL.md';
  if (!(manifest.files as readonly string[]).includes(name.slice(manifest.name.length + 1))) throw new TaskInspectionError('skill');
  return name;
}

function readInspectionFile(base: string, name: string, bundle = false): { text: string } {
  try {
    const canonicalBase = realpathSync(base);
    const resolved = realpathSync(path.resolve(base, name));
    // A manifest entry cannot redirect to an unlisted file, even inside the bundle.
    if (bundle && resolved !== path.resolve(canonicalBase, name)) throw new TaskInspectionError('boundary');
    if (!resolved.startsWith(canonicalBase + path.sep)
      || path.relative(canonicalBase, resolved).split(path.sep).some(part => part === '.git' || part === '.env')) throw new TaskInspectionError('boundary');
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size > 256000) throw new TaskInspectionError('boundary');
    return { text: readFileSync(resolved, 'utf8') };
  } catch (error) {
    if (error instanceof TaskInspectionError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new TaskInspectionError('missing');
    throw error;
  }
}

/** Fixed Git diff only; config cannot invoke an external diff, textconv or fsmonitor helper. */
function inspectDiff(root: string, scope: 'auto' | 'staged' | 'working-tree', inputPath?: string) {
  const options = { encoding: 'utf8' as const, timeout: 5000, maxBuffer: 512000, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
  const gitPrefix = ['-C', root, '--no-pager', '--no-optional-locks', '-c', 'core.fsmonitor=false'];
  // Git can also run clean/process filters when comparing worktree content.
  let filterKeys = '';
  try { filterKeys = execFileSync('git', [...gitPrefix, 'config', '--name-only', '--null', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], options); }
  catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
  const filters = [...new Set(filterKeys.split('\0').filter(Boolean).map(key => key.replace(/\.(clean|smudge|process|required)$/u, '')))];
  const disabledFilters = filters.flatMap(key => ['-c', `${key}.clean=`, '-c', `${key}.smudge=`, '-c', `${key}.process=`, '-c', `${key}.required=false`]);
  const prefix = [...gitPrefix, ...disabledFilters, 'diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all'];
  let selected: 'staged' | 'working-tree' = scope === 'staged' ? 'staged' : 'working-tree';
  if (scope === 'auto') {
    try { execFileSync('git', [...prefix, '--cached', '--quiet'], options); }
    catch (error) {
      if ((error as { status?: number }).status !== 1) throw error;
      selected = 'staged';
    }
  }
  let selector = '.';
  if (inputPath !== undefined) {
    if (inputPath.split(/[\\/]/u).some(p => p === '..' || p === '.git' || p === '.env')) throw new TaskInspectionError('path');
    const resolved = path.resolve(root, inputPath);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new TaskInspectionError('path');
    selector = `:(literal)${relative || '.'}`;
  }
  const text = execFileSync('git', [...prefix, ...(selected === 'staged' ? ['--cached'] : []), '--', selector,
    ':(exclude,glob)**/.env', ':(exclude,glob)**/.env/**', ':(exclude,glob)**/.git/**'], options);
  return { text, scope: selected };
}

/** Preparation-only inspection: fixed operations, no shell parser or executable supplied by the model. */
export function inspectTask(raw: unknown) {
  const input = parseAssurance(inspectTaskSchema, raw);
  // Bundled Skills belong to this package, not to the target checkout or its submodules.
  if (input.operation === 'skill') {
    const result = readInspectionFile(skillRoot, bundledSkillPath(input.path), true);
    return { ...result, contract: INTEGRATION_CONTRACT, loadedPackageVersion: PACKAGE_VERSION, contentHash: createHash('sha256').update(result.text).digest('hex') };
  }
  let root: string;
  try {
    root = realpathSync(execFileSync('git', ['-C', realpathSync(input.cwd), 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim());
  } catch { throw new TaskInspectionError('repository'); }
  if (input.operation === 'diff') return inspectDiff(root, input.scope ?? 'auto', input.path);
  if (input.operation === 'files' || input.operation === 'status') {
    const args = input.operation === 'files' ? ['ls-files', '--cached', '--others', '--exclude-standard'] : ['status', '--short'];
    return { text: execFileSync('git', ['-C', root, '--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { encoding: 'utf8', timeout: 5000, maxBuffer: 512000 }) };
  }
  const name = input.path ?? '';
  if (!name || name.split(/[\\/]/u).some(p => p === '..' || p === '.git' || p === '.env')) throw new TaskInspectionError('path');
  return readInspectionFile(root, name);
}
