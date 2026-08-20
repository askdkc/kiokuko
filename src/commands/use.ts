import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteText, readRegularFile } from '../agent-file/atomic-write.js';
import { AGENT_TEMPLATE_VERSION, renderAgentFile } from '../agent-file/render.js';
import { getGlobalDatabasePath } from '../config/paths.js';
import { readProjectConfig, type ProjectConfig } from '../config/project-config.js';
import { initializeDatabase } from './init.js';
import { openConnection } from '../db/connection.js';
import { registerRepositoryAndLocation } from '../repository/binding.js';
import { detectRepositoryRoot } from '../repository/detect-root.js';
import { createRepositoryIdentity } from '../repository/identity.js';
import { KiokukoError } from '../errors.js';
import { readGitOrigin } from '../repository/git-origin.js';

export interface UseOptions {
  cwd?: string;
  root?: string;
  workspace?: string;
  agentFile?: string;
  dryRun?: boolean;
  noAgentFile?: boolean;
  forceRebind?: boolean;
  allowDirectory?: boolean;
  databasePath?: string;
  migrationsDirectory?: string;
  repositoryId?: string;
}

export interface UseResult {
  repositoryRoot: string;
  repositoryId: string;
  workspace: string;
  databasePath: string;
  bindingFile: string;
  agentFile: string | null;
  agentFileAction: 'created' | 'updated' | 'unchanged' | 'skipped';
  bindingAction: 'created' | 'updated' | 'unchanged' | 'planned';
  dryRun: boolean;
  templateVersion: number;
}

function ensureChildPath(root: string, filePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(root, filePath);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new KiokukoError('VALIDATION_ERROR', 'agentFile must remain inside the repository root');
  }
  return resolvedPath;
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function bindingText(value: ProjectConfig): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function bindingAction(existing: string | undefined, next: string): UseResult['bindingAction'] {
  if (existing === undefined) return 'created';
  return existing === next ? 'unchanged' : 'updated';
}

function preferredCliCommand(): 'kiokuko' | 'npm exec -- kiokuko' {
  return process.env.npm_command === 'exec' || process.env.npm_lifecycle_event === 'npx'
    ? 'npm exec -- kiokuko'
    : 'kiokuko';
}

export async function useRepository(options: UseOptions = {}): Promise<UseResult> {
  const rootOptions: Parameters<typeof detectRepositoryRoot>[0] = {};
  if (options.cwd !== undefined) rootOptions.cwd = options.cwd;
  if (options.root !== undefined) rootOptions.root = options.root;
  if (options.allowDirectory !== undefined) rootOptions.allowDirectory = options.allowDirectory;
  const detected = detectRepositoryRoot(rootOptions);
  const repositoryRoot = detected.root;
  const bindingFile = path.join(repositoryRoot, '.kiokuko.json');
  const existingBindingText = await readOptionalText(bindingFile);
  const existingBinding = existingBindingText === undefined ? undefined : await readProjectConfig(bindingFile);
  if (existingBinding && options.workspace && existingBinding.workspace !== options.workspace && !options.forceRebind) {
    throw new KiokukoError('CONFLICT', 'Existing binding uses another workspace; pass --force-rebind to change it');
  }

  const requestedAgentFile = options.agentFile ?? existingBinding?.agentFile ?? 'AGENTS.md';
  const agentFile = ensureChildPath(repositoryRoot, requestedAgentFile);
  const existingAgent = options.noAgentFile ? undefined : await readRegularFile(agentFile);
  const identityOptions: Parameters<typeof createRepositoryIdentity>[0] = { repositoryRoot };
  const remote = readGitOrigin(repositoryRoot);
  if (remote !== undefined) identityOptions.remoteUrl = remote;
  if (options.repositoryId !== undefined) identityOptions.repositoryId = options.repositoryId;
  if (existingBinding) {
    identityOptions.existingBinding = {
      repositoryId: existingBinding.repositoryId,
      workspace: existingBinding.workspace,
    };
  }
  if (options.workspace !== undefined) identityOptions.workspace = options.workspace;
  const identity = createRepositoryIdentity(identityOptions);
  if (existingBinding && options.workspace && existingBinding.workspace !== identity.workspace && !options.forceRebind) {
    throw new KiokukoError('CONFLICT', 'Existing binding uses another workspace; pass --force-rebind to change it');
  }

  const nextBinding: ProjectConfig = {
    schemaVersion: 1,
    repositoryId: identity.repositoryId,
    workspace: identity.workspace,
    agentFile: requestedAgentFile,
    templateVersion: AGENT_TEMPLATE_VERSION,
  };
  const nextBindingText = bindingText(nextBinding);
  const rendered = options.noAgentFile
    ? undefined
    : renderAgentFile(existingAgent?.content, {
        repositoryId: identity.repositoryId,
        workspace: identity.workspace,
        cliCommand: preferredCliCommand(),
        templateVersion: AGENT_TEMPLATE_VERSION,
      });
  const databasePath = options.databasePath ?? getGlobalDatabasePath();
  const result: UseResult = {
    repositoryRoot,
    repositoryId: identity.repositoryId,
    workspace: identity.workspace,
    databasePath,
    bindingFile,
    agentFile: options.noAgentFile ? null : agentFile,
    agentFileAction: options.noAgentFile ? 'skipped' : rendered?.action ?? 'unchanged',
    bindingAction: options.dryRun ? 'planned' : bindingAction(existingBindingText, nextBindingText),
    dryRun: options.dryRun ?? false,
    templateVersion: AGENT_TEMPLATE_VERSION,
  };
  if (options.dryRun) return result;

  const initOptions: Parameters<typeof initializeDatabase>[0] = { databasePath };
  if (options.migrationsDirectory !== undefined) initOptions.migrationsDirectory = options.migrationsDirectory;
  await initializeDatabase(initOptions);
  const database = openConnection(databasePath);
  let retryBinding: { repositoryId: string; workspace: string } | undefined;
  try {
    try {
      registerRepositoryAndLocation(database, {
        repositoryId: identity.repositoryId,
        workspace: identity.workspace,
        displayName: identity.displayName,
        canonicalRoot: repositoryRoot,
        remoteFingerprint: identity.remoteFingerprint,
        bindingSchemaVersion: 1,
        agentTemplateVersion: AGENT_TEMPLATE_VERSION,
      });
    } catch (error) {
      if (error instanceof KiokukoError && error.code === 'CONFLICT' && options.repositoryId === undefined && options.workspace === undefined && existingBinding === undefined) {
        retryBinding = database.prepare(`
          SELECT r.repository_id AS repositoryId, r.workspace AS workspace
          FROM repositories r JOIN repository_locations l ON l.repository_id = r.repository_id
          WHERE l.canonical_root = ?
        `).get<{ repositoryId: string; workspace: string }>(repositoryRoot);
      }
      if (!retryBinding) throw error;
    }
  } finally {
    database.close();
  }
  if (retryBinding) {
    return useRepository({ ...options, repositoryId: retryBinding.repositoryId, workspace: retryBinding.workspace });
  }

  const originalBinding = existingBindingText;
  const originalAgent = existingAgent?.content;
  try {
    if (result.bindingAction !== 'unchanged') await atomicWriteText(bindingFile, nextBindingText, 0o644);
    if (rendered && rendered.action !== 'unchanged') await atomicWriteText(agentFile, rendered.content, existingAgent?.mode ?? 0o644);
  } catch (error) {
    if (originalBinding === undefined) await unlink(bindingFile).catch(() => undefined);
    else await atomicWriteText(bindingFile, originalBinding, 0o644).catch(() => undefined);
    if (options.noAgentFile) {
      // No agent file was requested, so there is nothing to restore.
    } else if (originalAgent === undefined) {
      await unlink(agentFile).catch(() => undefined);
    } else {
      await atomicWriteText(agentFile, originalAgent, existingAgent?.mode ?? 0o644).catch(() => undefined);
    }
    throw error;
  }
  return result;
}

export const use = useRepository;
