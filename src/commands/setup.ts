import { access, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { atomicWriteText, readRegularFile } from '../agent-file/atomic-write.js';
import {
  getClaudeInstructionsPath,
  getClaudeMcpConfigPath,
  getClaudeSkillsDirectory,
  getCodexConfigPath,
  getCodexInstructionsPath,
  getCodexSkillsDirectory,
  getGlobalDatabasePath,
  getHermesConfigPath,
  getHermesSkillsDirectory,
  getOpenCodeConfigDirectory,
  getOpenCodeInstructionsPath,
  getOpenCodeLoopGuardPath,
  getOpenCodeSkillsDirectory,
  type PathEnvironment,
} from '../config/paths.js';
import { initializeDatabase } from './init.js';
import { openConnection } from '../db/connection.js';
import { ensureGlobalWorkspace } from '../memory/workspaces.js';
import { KiokukoError } from '../errors.js';
import { renderOpenCodeConfig } from '../setup/opencode-config.js';
import { renderOpenCodeLoopGuard, type OpenCodeLoopGuardOptions } from '../setup/opencode-loop-guard.js';
import { renderCodexMcpConfig, renderGlobalInstructions } from '../setup/render.js';
import { renderClaudeConfig } from '../setup/claude-config.js';
import { renderHermesConfig } from '../setup/hermes-config.js';
import { detectInstalledClients } from '../setup/client-detection.js';
import {
  loadBundledStandardSkillFiles,
  renderStandardSkillFile,
  STANDARD_UI_SKILL_NAME,
} from '../setup/standard-skills.js';

export const SETUP_CLIENTS = ['codex', 'opencode', 'claude', 'hermes'] as const;
export type SetupClient = (typeof SETUP_CLIENTS)[number];
type SetupAction = 'created' | 'updated' | 'unchanged';

interface PlannedFile {
  path: string;
  content: string;
  mode: number;
  original: string | undefined;
  action: SetupAction;
  purpose: 'mcp-config' | 'instructions' | 'runtime-guard' | 'standard-skill';
  client: SetupClient;
}

export interface SetupOptions extends PathEnvironment {
  clients?: SetupClient[];
  command?: string;
  dryRun?: boolean;
  databasePath?: string;
  migrationsDirectory?: string;
  opencodeCapture?: OpenCodeLoopGuardOptions['captureProfile'];
  opencodeMode?: OpenCodeLoopGuardOptions['mode'];
  standardSkills?: boolean;
}

export interface SetupResult {
  clients: SetupClient[];
  databasePath: string;
  databaseAction: 'initialized' | 'planned';
  databaseBackupPath: string | null;
  appliedMigrations: number[];
  files: Array<Pick<PlannedFile, 'path' | 'action' | 'purpose' | 'client'>>;
  standardSkills: boolean;
  dryRun: boolean;
  nextStep: string;
}

export interface SetupPromptOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export function parseSetupClients(value: string): SetupClient[] {
  const clients = [...new Set(value.split(',').map((client) => client.trim()).filter(Boolean))];
  if (clients.length === 0 || clients.some((client) => !SETUP_CLIENTS.includes(client as SetupClient))) {
    throw new KiokukoError('VALIDATION_ERROR', `clients must be a comma-separated subset of: ${SETUP_CLIENTS.join(', ')}`);
  }
  return clients as SetupClient[];
}

function setupClientLabel(client: SetupClient): string {
  if (client === 'codex') return 'Codex';
  if (client === 'opencode') return 'OpenCode';
  if (client === 'claude') return 'Claude Code';
  return 'Hermes Agent';
}

/** Ask which supported clients should receive configuration in an interactive terminal. */
export async function promptSetupClients(detected: SetupClient[], options: SetupPromptOptions = {}): Promise<SetupClient[]> {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  const prompt = createInterface({ input, output });
  const defaultSelection = detected.length === 0 ? 'none' : detected.join(',');
  try {
    output.write('Select clients to configure (detected clients are preselected):\n');
    for (const [index, client] of SETUP_CLIENTS.entries()) {
      const checked = detected.includes(client) ? 'x' : ' ';
      const status = detected.includes(client) ? 'detected' : 'not detected';
      output.write(`  ${index + 1}. [${checked}] ${setupClientLabel(client)} (${status})\n`);
    }
    output.write('Enter client names or numbers separated by commas. Press Enter to accept the checked clients; type none to skip all.\n');
    while (true) {
      const answer = (await prompt.question(`Clients [${defaultSelection}]: `)).trim();
      if (answer.length === 0) return detected;
      if (/^(?:none|なし)$/iu.test(answer)) return [];
      const selected: string[] = [];
      let invalid = false;
      for (const token of answer.split(',').map((value) => value.trim()).filter(Boolean)) {
        const index = Number(token);
        const indexedClient = Number.isInteger(index) && index >= 1 && index <= SETUP_CLIENTS.length
          ? SETUP_CLIENTS[index - 1]
          : undefined;
        const client = indexedClient ?? token.toLowerCase();
        if (!SETUP_CLIENTS.includes(client as SetupClient)) {
          invalid = true;
          break;
        }
        selected.push(client);
      }
      if (!invalid) return [...new Set(selected)] as SetupClient[];
      output.write(`Invalid selection. Choose names or numbers for: ${SETUP_CLIENTS.join(', ')}.\n`);
    }
  } finally {
    prompt.close();
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function planFile(
  filePath: string,
  client: SetupClient,
  purpose: PlannedFile['purpose'],
  render: (existing: string | undefined) => { content: string; action: SetupAction },
): Promise<PlannedFile> {
  const original = await readRegularFile(filePath);
  const rendered = render(original?.content);
  const action: SetupAction = original === undefined
    ? 'created'
    : rendered.content === original.content ? 'unchanged' : 'updated';
  return {
    path: filePath,
    content: rendered.content,
    mode: original?.mode ?? 0o600,
    original: original?.content,
    action,
    purpose,
    client,
  };
}

async function openCodeConfigPath(options: PathEnvironment): Promise<string> {
  const directory = getOpenCodeConfigDirectory(options);
  const jsonc = path.join(directory, 'opencode.jsonc');
  if (await exists(jsonc)) return jsonc;
  return path.join(directory, 'opencode.json');
}

async function restoreFiles(files: PlannedFile[]): Promise<void> {
  for (const file of [...files].reverse()) {
    if (file.action === 'unchanged') continue;
    if (file.original === undefined) await unlink(file.path).catch(() => undefined);
    else await atomicWriteText(file.path, file.original, file.mode).catch(() => undefined);
  }
}

function setupNextStep(clients: SetupClient[], standardSkills: boolean): string {
  return clients.map((client) => {
    if (client === 'hermes') {
      return standardSkills
        ? 'Restart Hermes Agent, or use /reload-mcp and start a new session, so it reloads its profile-scoped MCP configuration and standard skills.'
        : 'Restart Hermes Agent or use /reload-mcp to reload its profile-scoped MCP configuration.';
    }
    const label = client === 'codex' ? 'Codex' : client === 'opencode' ? 'OpenCode' : 'Claude Code';
    return `Restart ${label} so it reloads global MCP and instruction configuration${standardSkills ? ' and standard skills' : ''}.`;
  }).join(' ');
}

async function standardSkillDirectory(client: SetupClient, options: PathEnvironment): Promise<string> {
  if (client === 'codex') return getCodexSkillsDirectory(options);
  if (client === 'opencode') return getOpenCodeSkillsDirectory(options);
  if (client === 'claude') return getClaudeSkillsDirectory(options);
  return getHermesSkillsDirectory(options);
}

export async function setupGlobalClients(options: SetupOptions = {}): Promise<SetupResult> {
  const pathEnvironment: PathEnvironment = {
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.env === undefined ? {} : { env: options.env }),
  };
  const clients = options.clients ?? await detectInstalledClients(pathEnvironment);
  if (clients.some((client) => !SETUP_CLIENTS.includes(client))) {
    throw new KiokukoError('VALIDATION_ERROR', `clients must be a subset of: ${SETUP_CLIENTS.join(', ')}`);
  }
  const command = options.command ?? 'kiokuko';
  if (command.trim().length === 0 || command.includes('\0')) throw new KiokukoError('VALIDATION_ERROR', 'command must be a non-empty executable path or name');
  const databasePath = options.databasePath ?? getGlobalDatabasePath(pathEnvironment);
  const standardSkills = options.standardSkills ?? true;
  const files: PlannedFile[] = [];

  if (clients.includes('codex')) {
    files.push(await planFile(getCodexConfigPath(pathEnvironment), 'codex', 'mcp-config', (existing) => renderCodexMcpConfig(existing ?? '', command)));
    files.push(await planFile(getCodexInstructionsPath(pathEnvironment), 'codex', 'instructions', (existing) => renderGlobalInstructions(existing ?? '')));
  }
  if (clients.includes('opencode')) {
    files.push(await planFile(await openCodeConfigPath(pathEnvironment), 'opencode', 'mcp-config', (existing) => renderOpenCodeConfig(existing, command)));
    files.push(await planFile(getOpenCodeInstructionsPath(pathEnvironment), 'opencode', 'instructions', (existing) => renderGlobalInstructions(existing ?? '')));
    files.push(await planFile(getOpenCodeLoopGuardPath(pathEnvironment), 'opencode', 'runtime-guard', (existing) => renderOpenCodeLoopGuard(existing, {
      ...(options.opencodeCapture === undefined ? {} : { captureProfile: options.opencodeCapture }),
      ...(options.opencodeMode === undefined ? {} : { mode: options.opencodeMode }),
    })));
  }
  if (clients.includes('claude')) {
    files.push(await planFile(getClaudeMcpConfigPath(pathEnvironment), 'claude', 'mcp-config', (existing) => renderClaudeConfig(existing, command)));
    files.push(await planFile(getClaudeInstructionsPath(pathEnvironment), 'claude', 'instructions', (existing) => renderGlobalInstructions(existing ?? '')));
  }
  if (clients.includes('hermes')) {
    files.push(await planFile(await getHermesConfigPath(pathEnvironment), 'hermes', 'mcp-config', (existing) => renderHermesConfig(existing, command)));
  }

  if (standardSkills) {
    const bundledFiles = await loadBundledStandardSkillFiles();
    for (const client of clients) {
      const destination = path.join(await standardSkillDirectory(client, pathEnvironment), STANDARD_UI_SKILL_NAME);
      for (const bundled of bundledFiles) {
        files.push(await planFile(path.join(destination, bundled.relativePath), client, 'standard-skill', (existing) => renderStandardSkillFile(existing, bundled)));
      }
    }
  }

  const result: SetupResult = {
    clients,
    databasePath,
    databaseAction: options.dryRun ? 'planned' : 'initialized',
    databaseBackupPath: null,
    appliedMigrations: [],
    files: files.map(({ path: filePath, action, purpose, client }) => ({ path: filePath, action, purpose, client })),
    standardSkills,
    dryRun: options.dryRun ?? false,
    nextStep: setupNextStep(clients, standardSkills),
  };
  if (options.dryRun) return result;

  const initialized = await initializeDatabase({
    databasePath,
    ...(options.migrationsDirectory === undefined ? {} : { migrationsDirectory: options.migrationsDirectory }),
  });
  result.databaseBackupPath = initialized.backupPath;
  result.appliedMigrations = initialized.applied;
  const database = openConnection(databasePath);
  try {
    ensureGlobalWorkspace(database);
  } finally {
    database.close();
  }

  const written: PlannedFile[] = [];
  try {
    for (const file of files) {
      if (file.action === 'unchanged') continue;
      await atomicWriteText(file.path, file.content, file.mode);
      written.push(file);
    }
  } catch (error) {
    await restoreFiles(written);
    throw error;
  }
  return result;
}
