import { constants, existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { readRegularFile } from '../agent-file/atomic-write.js';
import { useRepository } from '../commands/use.js';
import type { ProjectAgentRefreshResult } from './project-agent-refresh.js';
import { KiokukoError } from '../errors.js';
import { openConnection } from '../db/connection.js';
import { detectGitWorktree } from '../repository/detect-root.js';

/** Only the projects explicitly added to this Codex profile authorize recording. */
export async function codexProjectWorktrees(configPath: string): Promise<string[]> {
  let file;
  try { file = await open(path.join(path.dirname(configPath), '.codex-global-state.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  let value: unknown;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 8 * 1024 * 1024 || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o022)) {
      throw new KiokukoError('SECURITY_REJECTION', 'Codex project state must be a bounded regular file owned by you');
    }
    value = JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
  const roots: unknown = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)['electron-saved-workspace-roots'] : undefined;
  if (roots === undefined) return [];
  if (!Array.isArray(roots) || roots.length > 256 || roots.some(root => typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0') || root.length > 4096)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Codex project roots must be a bounded list of absolute paths');
  }
  const worktrees = [...new Set((roots as string[]).map(root => detectGitWorktree(root)).filter((root): root is string => root !== undefined))];
  if (worktrees.length > 64) throw new KiokukoError('VALIDATION_ERROR', 'Codex recording supports at most 64 Git worktrees');
  return worktrees;
}

/** Reuse normal binding/instruction checks, preserving deliberately removed instructions. */
export async function refreshCodexProject(root: string, databasePath: string, dryRun = false): Promise<ProjectAgentRefreshResult | undefined> {
  const binding = await readRegularFile(path.join(root, '.kiokuko.json'));
  let registered = binding !== undefined;
  if (!registered && existsSync(databasePath)) {
    const database = openConnection(databasePath, { readOnly: true });
    try {
      if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='repository_locations'").get()) {
        registered = database.prepare('SELECT 1 FROM repository_locations WHERE canonical_root = ?').get(root) !== undefined;
      }
    } finally { database.close(); }
  }
  try {
    const project = await useRepository({ root, databasePath, dryRun, ensureNewBindingIgnored: true,
      requireExistingAgentFile: registered, preserveDshAgentFile: true });
    if (!project.agentFile || project.agentFileAction === 'skipped') return undefined;
    return { repositoryRoot: project.repositoryRoot, repositoryId: project.repositoryId, workspace: project.workspace,
      status: project.agentFileAction, agentFile: project.agentFile, bindingAction: project.bindingAction };
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'NOT_FOUND'
      && (error.details.reason === 'missing_agent_file' || error.details.reason === 'foreign_agent_file')) return undefined;
    throw error;
  }
}
