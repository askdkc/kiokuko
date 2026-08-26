import path from 'node:path';
import { mkdir, rmdir } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  atomicWriteTextIfUnchanged,
  assertAtomicCleanupComplete,
  AtomicCommittedMutationError,
  AtomicCommittedUnlinkError,
  assertFileExpectation,
  readDirectoryIdentity,
  readRegularFile,
  unlinkRegularFileIfUnchanged,
  type FileExpectation,
  type FileIdentity,
  type RegularFileSnapshot,
} from '../agent-file/atomic-write.js';
import {
  getClaudeInstructionsPath,
  getClaudeMcpConfigPath,
  getClaudeSkillsDirectory,
  getCodexConfigPath,
  getCodexInstructionsPath,
  getCodexSkillsDirectory,
  getGlobalDatabasePath,
  getLegacyClaudePromptHookSettingsPath,
  getLegacyOpenCodeLoopGuardPath,
  getOpenCodeConfigDirectory,
  getOpenCodeInstructionsPath,
  getOpenCodeSkillsDirectory,
  resolveHermesProfilePaths,
  type HermesProfilePaths,
  type PathEnvironment,
} from '../config/paths.js';
import { initializeDatabase } from './init.js';
import { databaseFileIdentity, openConnection } from '../db/connection.js';
import { ensureGlobalWorkspace } from '../memory/workspaces.js';
import { KiokukoError } from '../errors.js';
import { isSkillDiscoveryMode, normalizeSkillDiscoveryMode, SKILL_DISCOVERY_ENV } from '../skills/config.js';
import type { SkillDiscoveryMode } from '../skills/types.js';
import { renderOpenCodeConfig } from '../setup/opencode-config.js';
import { renderCodexMcpConfig, renderGlobalInstructions } from '../setup/render.js';
import { renderClaudeConfig } from '../setup/claude-config.js';
import { renderHermesConfig } from '../setup/hermes-config.js';
import { detectInstalledClients } from '../setup/client-detection.js';
import {
  assertExactLegacyOpenCodeLoopGuard,
  cleanupLegacyClaudePromptHook,
} from '../setup/legacy-client-cleanup.js';
import {
  loadBundledStandardSkillFiles,
  renderStandardSkillFile,
} from '../setup/standard-skills.js';
import {
  listRegisteredProjectLocations,
  refreshRegisteredProjectAgentFiles,
  type ProjectAgentRefreshResult,
  type RegisteredProjectLocation,
} from '../setup/project-agent-refresh.js';

export const SETUP_CLIENTS = ['codex', 'opencode', 'claude', 'hermes'] as const;
export type SetupClient = (typeof SETUP_CLIENTS)[number];
type SetupAction = 'created' | 'updated' | 'unchanged' | 'deleted';

interface PlannedDirectory {
  path: string;
  parent: PlannedDirectory | undefined;
  original: FileIdentity | undefined;
  created: FileIdentity | undefined;
}

interface SetupPlanningContext {
  directories: Map<string, PlannedDirectory>;
}

function setupPathJoin(options: PathEnvironment, ...segments: string[]): string {
  const platform = options.platform ?? process.platform;
  return platform === 'win32' ? path.win32.join(...segments) : path.posix.join(...segments);
}

interface PlannedFile {
  path: string;
  parentDirectory: PlannedDirectory;
  content: string | undefined;
  mode: number;
  original: RegularFileSnapshot | undefined;
  mustRemainAbsent?: readonly string[];
  action: SetupAction;
  purpose: 'mcp-config' | 'instructions' | 'standard-skill' | 'legacy-cleanup';
  client: SetupClient;
  report: boolean;
}

export interface SetupOptions extends PathEnvironment {
  clients?: SetupClient[];
  command?: string;
  dryRun?: boolean;
  databasePath?: string;
  migrationsDirectory?: string;
  standardSkills?: boolean;
  skillDiscoveryMode?: SkillDiscoveryMode;
  replaceConflictingMcpServers?: readonly SetupClient[];
}

export interface SetupCommandDependencies {
  atomicWriteTextIfUnchanged?: typeof atomicWriteTextIfUnchanged;
  unlinkRegularFileIfUnchanged?: typeof unlinkRegularFileIfUnchanged;
  beforeCommit?: () => void | Promise<void>;
  openConnection?: typeof openConnection;
  ensureGlobalWorkspace?: typeof ensureGlobalWorkspace;
  refreshRegisteredProjectAgentFiles?: typeof refreshRegisteredProjectAgentFiles;
}

export interface SetupResult {
  clients: SetupClient[];
  databasePath: string;
  databaseAction: 'initialized' | 'planned';
  databaseBackupPath: string | null;
  appliedMigrations: number[];
  recoveredEntries: number;
  files: Array<Pick<PlannedFile, 'path' | 'action' | 'purpose' | 'client'>>;
  projectAgentFiles: ProjectAgentRefreshResult[];
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

export function parseSetupSkillDiscoveryMode(value: string): SkillDiscoveryMode {
  if (!isSkillDiscoveryMode(value)) {
    throw new KiokukoError('VALIDATION_ERROR', 'skill discovery must be off, official, or community');
  }
  return value;
}

function setupClientLabel(client: SetupClient): string {
  if (client === 'codex') return 'Codex';
  if (client === 'opencode') return 'OpenCode';
  if (client === 'claude') return 'Claude Code';
  return 'Hermes Agent';
}

interface SetupQuestion {
  question(query: string): Promise<string>;
}

async function askSetupClients(prompt: SetupQuestion, output: NodeJS.WritableStream, detected: SetupClient[]): Promise<SetupClient[]> {
  const defaultSelection = detected.length === 0 ? 'none' : detected.join(',');
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
}

async function askCommunitySkillDiscovery(prompt: SetupQuestion, output: NodeJS.WritableStream): Promise<SkillDiscoveryMode> {
  output.write('Official external Skill discovery is enabled by default and uses validated content only as untrusted references. It never installs or executes Skills.\n');
  output.write('Community discovery can also use audited community Skills as untrusted references when relevant.\n');
  const answer = (await prompt.question('Enable community Skill discovery? [y/N] ')).trim();
  return /^(?:y|yes|はい)$/iu.test(answer) ? 'community' : 'official';
}

async function askReplaceConflictingMcp(
  prompt: SetupQuestion,
  output: NodeJS.WritableStream,
  client: SetupClient,
): Promise<boolean> {
  const label = setupClientLabel(client);
  output.write(`${label} already has a non-canonical or unmanaged Kiokuko MCP identity.\n`);
  output.write('Kiokuko can remove that identity, install the managed configuration, and continue setup.\n');
  const answer = (await prompt.question(`Replace the existing ${label} Kiokuko MCP identity and continue? [Y/n] `)).trim();
  return answer.length === 0 || /^(?:y|yes|はい)$/iu.test(answer);
}

/** Ask which supported clients should receive configuration in an interactive terminal. */
export async function promptSetupClients(detected: SetupClient[], options: SetupPromptOptions = {}): Promise<SetupClient[]> {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  const prompt = createInterface({ input, output });
  try {
    return await askSetupClients(prompt, output, detected);
  } finally {
    prompt.close();
  }
}

/** Ask whether audited community Skill discovery should be enabled. */
export async function promptCommunitySkillDiscovery(options: SetupPromptOptions = {}): Promise<SkillDiscoveryMode> {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  const prompt = createInterface({ input, output });
  try {
    return await askCommunitySkillDiscovery(prompt, output);
  } finally {
    prompt.close();
  }
}

/** Ask before replacing a client Kiokuko MCP identity that setup does not own. */
export async function promptReplaceConflictingMcp(
  client: SetupClient,
  options: SetupPromptOptions = {},
): Promise<boolean> {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  const prompt = createInterface({ input, output });
  try {
    return await askReplaceConflictingMcp(prompt, output, client);
  } finally {
    prompt.close();
  }
}

function replacementClientSet(value: readonly SetupClient[] | undefined): ReadonlySet<SetupClient> {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)
    || value.some((client) => !SETUP_CLIENTS.includes(client))
    || new Set(value).size !== value.length) {
    throw new KiokukoError(
      'VALIDATION_ERROR',
      `replaceConflictingMcpServers must be a unique subset of: ${SETUP_CLIENTS.join(', ')}`,
    );
  }
  return new Set(value);
}

/** Ask both setup questions through one readline session so buffered input remains intact. */
export async function promptSetupConfiguration(detected: SetupClient[], options: SetupPromptOptions = {}): Promise<{ clients: SetupClient[]; skillDiscoveryMode: SkillDiscoveryMode }> {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  const prompt = createInterface({ input, output });
  try {
    const clients = await askSetupClients(prompt, output, detected);
    const skillDiscoveryMode = clients.length === 0
      ? 'official'
      : await askCommunitySkillDiscovery(prompt, output);
    return { clients, skillDiscoveryMode };
  } finally {
    prompt.close();
  }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function setupDirectoryChanged(directoryPath: string): KiokukoError {
  return new KiokukoError(
    'CONFLICT',
    'Setup directory changed after planning',
    { target: directoryPath },
  );
}

function plannedDirectoryIdentity(directory: PlannedDirectory): FileIdentity | undefined {
  return directory.original ?? directory.created;
}

function directoryLineage(directory: PlannedDirectory): PlannedDirectory[] {
  const lineage: PlannedDirectory[] = [];
  let current: PlannedDirectory | undefined = directory;
  while (current !== undefined) {
    lineage.push(current);
    current = current.parent;
  }
  return lineage.reverse();
}

async function assertPlannedDirectory(directory: PlannedDirectory): Promise<void> {
  for (const planned of directoryLineage(directory)) {
    const current = await readDirectoryIdentity(planned.path);
    const expected = plannedDirectoryIdentity(planned);
    if (
      (current === undefined) !== (expected === undefined)
      || (current !== undefined && expected !== undefined && !sameFileIdentity(current, expected))
    ) {
      throw setupDirectoryChanged(planned.path);
    }
  }
}

async function planDirectory(
  planning: SetupPlanningContext,
  directoryPath: string,
): Promise<PlannedDirectory> {
  const resolved = path.resolve(directoryPath);
  const existing = planning.directories.get(resolved);
  if (existing !== undefined) return existing;

  const original = await readDirectoryIdentity(resolved);
  const parentPath = path.dirname(resolved);
  const parent = original !== undefined || parentPath === resolved
    ? undefined
    : await planDirectory(planning, parentPath);
  const planned: PlannedDirectory = {
    path: resolved,
    parent,
    original,
    created: undefined,
  };
  planning.directories.set(resolved, planned);
  return planned;
}

async function readPlannedRegularFile(
  planning: SetupPlanningContext,
  filePath: string,
): Promise<{ parentDirectory: PlannedDirectory; snapshot: RegularFileSnapshot | undefined }> {
  const parentDirectory = await planDirectory(planning, path.dirname(filePath));
  await assertPlannedDirectory(parentDirectory);
  const snapshot = await readRegularFile(filePath);
  await assertPlannedDirectory(parentDirectory);
  return { parentDirectory, snapshot };
}

function errno(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

async function preparePlannedDirectories(
  files: PlannedFile[],
  createdDirectories: PlannedDirectory[],
): Promise<void> {
  const required = new Set<PlannedDirectory>();
  for (const file of files) {
    if (file.action === 'unchanged') continue;
    for (const directory of directoryLineage(file.parentDirectory)) required.add(directory);
  }

  const ordered = [...required].sort((left, right) => directoryLineage(left).length - directoryLineage(right).length);
  for (const directory of ordered) {
    const expected = plannedDirectoryIdentity(directory);
    if (expected !== undefined) {
      await assertPlannedDirectory(directory);
      continue;
    }
    if (directory.parent === undefined) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Setup cannot create a missing filesystem root');
    }
    await assertPlannedDirectory(directory.parent);
    if (await readDirectoryIdentity(directory.path) !== undefined) {
      throw setupDirectoryChanged(directory.path);
    }
    try {
      await mkdir(directory.path, { mode: 0o700 });
    } catch (error) {
      if (errno(error) === 'EEXIST') throw setupDirectoryChanged(directory.path);
      throw error;
    }
    const created = await readDirectoryIdentity(directory.path);
    if (created === undefined) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Setup directory disappeared immediately after creation', {
        target: directory.path,
      });
    }
    directory.created = created;
    createdDirectories.push(directory);
    await assertPlannedDirectory(directory);
  }
}

async function removeCreatedDirectories(createdDirectories: PlannedDirectory[]): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const directory of [...createdDirectories].reverse()) {
    try {
      await assertPlannedDirectory(directory);
      await rmdir(directory.path);
      if (await readDirectoryIdentity(directory.path) !== undefined) {
        throw setupDirectoryChanged(directory.path);
      }
      directory.created = undefined;
      if (directory.parent !== undefined) await assertPlannedDirectory(directory.parent);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function planFile(
  planning: SetupPlanningContext,
  filePath: string,
  client: SetupClient,
  purpose: PlannedFile['purpose'],
  render: (existing: string | undefined) => { content: string; action: SetupAction },
  mustRemainAbsent: readonly string[] = [],
): Promise<PlannedFile> {
  const { parentDirectory, snapshot: original } = await readPlannedRegularFile(planning, filePath);
  const rendered = render(original?.content);
  const action: SetupAction = original === undefined
    ? 'created'
    : rendered.content === original.content ? 'unchanged' : 'updated';
  return {
    path: filePath,
    parentDirectory,
    content: rendered.content,
    mode: original?.mode ?? 0o600,
    original,
    ...(mustRemainAbsent.length === 0 ? {} : { mustRemainAbsent }),
    action,
    purpose,
    client,
    report: true,
  };
}

async function planLegacyClaudeHookCleanup(
  planning: SetupPlanningContext,
  options: PathEnvironment,
): Promise<PlannedFile> {
  const filePath = getLegacyClaudePromptHookSettingsPath(options);
  const { parentDirectory, snapshot: original } = await readPlannedRegularFile(planning, filePath);
  const content = original === undefined ? undefined : cleanupLegacyClaudePromptHook(original.content);
  const changed = original !== undefined && content !== original.content;
  return {
    path: filePath,
    parentDirectory,
    content,
    mode: original?.mode ?? 0o600,
    original,
    action: changed ? 'updated' : 'unchanged',
    purpose: 'legacy-cleanup',
    client: 'claude',
    report: changed,
  };
}

async function planLegacyOpenCodeGuardCleanup(
  planning: SetupPlanningContext,
  options: PathEnvironment,
): Promise<PlannedFile> {
  const filePath = getLegacyOpenCodeLoopGuardPath(options);
  const { parentDirectory, snapshot: original } = await readPlannedRegularFile(planning, filePath);
  if (original !== undefined) assertExactLegacyOpenCodeLoopGuard(original.content);
  return {
    path: filePath,
    parentDirectory,
    content: undefined,
    mode: original?.mode ?? 0o600,
    original,
    action: original === undefined ? 'unchanged' : 'deleted',
    purpose: 'legacy-cleanup',
    client: 'opencode',
    report: original !== undefined,
  };
}

async function openCodeConfigPath(
  planning: SetupPlanningContext,
  options: PathEnvironment,
): Promise<{ path: string; mustRemainAbsent: readonly string[] }> {
  const directory = getOpenCodeConfigDirectory(options);
  const jsonc = setupPathJoin(options, directory, 'opencode.jsonc');
  if ((await readPlannedRegularFile(planning, jsonc)).snapshot !== undefined) {
    return { path: jsonc, mustRemainAbsent: [] };
  }
  return { path: setupPathJoin(options, directory, 'opencode.json'), mustRemainAbsent: [jsonc] };
}

interface AppliedFileMutation {
  file: PlannedFile;
  installed: RegularFileSnapshot | undefined;
}

async function restoreFiles(
  mutations: AppliedFileMutation[],
  dependencies: Required<Pick<SetupCommandDependencies, 'atomicWriteTextIfUnchanged' | 'unlinkRegularFileIfUnchanged'>>,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const mutation of [...mutations].reverse()) {
    const { file, installed } = mutation;
    try {
      if (file.original === undefined) {
        if (installed === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Setup rollback record is invalid');
        const outcome = await dependencies.unlinkRegularFileIfUnchanged(
          file.path,
          fileExpectation(file, installed, false),
        );
        assertAtomicCleanupComplete(outcome);
      } else {
        const outcome = await dependencies.atomicWriteTextIfUnchanged(
          file.path,
          file.original.content,
          fileExpectation(file, installed, false),
          file.original.mode,
        );
        assertAtomicCleanupComplete(outcome);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
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

async function standardSkillDirectory(
  client: SetupClient,
  options: PathEnvironment,
  hermesProfile: HermesProfilePaths | undefined,
): Promise<string> {
  if (client === 'codex') return getCodexSkillsDirectory(options);
  if (client === 'opencode') return getOpenCodeSkillsDirectory(options);
  if (client === 'claude') return getClaudeSkillsDirectory(options);
  if (hermesProfile === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Hermes profile was not bound during setup planning');
  return hermesProfile.skillsDirectory;
}

function fileExpectation(
  file: PlannedFile,
  expected: RegularFileSnapshot | undefined,
  includeAlternatePaths = true,
): FileExpectation {
  const expectedParentDirectory = plannedDirectoryIdentity(file.parentDirectory);
  if (expectedParentDirectory === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Setup file parent was not created or bound before mutation', {
      target: file.parentDirectory.path,
    });
  }
  return {
    expected,
    expectedParentDirectory,
    ...(includeAlternatePaths && file.mustRemainAbsent !== undefined
      ? { mustRemainAbsent: file.mustRemainAbsent }
      : {}),
  };
}

async function assertPlannedFile(
  file: PlannedFile,
  expected: RegularFileSnapshot | undefined,
): Promise<void> {
  await assertPlannedDirectory(file.parentDirectory);
  if (plannedDirectoryIdentity(file.parentDirectory) === undefined) {
    if (expected !== undefined || await readRegularFile(file.path) !== undefined) {
      throw setupDirectoryChanged(file.parentDirectory.path);
    }
    for (const absentPath of file.mustRemainAbsent ?? []) {
      if (await readRegularFile(absentPath) !== undefined) {
        throw new KiokukoError('CONFLICT', 'Setup target changed after planning', { target: absentPath });
      }
    }
  } else {
    await assertFileExpectation(file.path, fileExpectation(file, expected));
  }
  await assertPlannedDirectory(file.parentDirectory);
}

async function assertPlannedFiles(
  files: PlannedFile[],
  applied: AppliedFileMutation[] = [],
): Promise<void> {
  const installedByPath = new Map(applied.map((mutation) => [mutation.file.path, mutation.installed]));
  for (const file of files) {
    const expected = installedByPath.has(file.path) ? installedByPath.get(file.path) : file.original;
    await assertPlannedFile(file, expected);
  }
}

function setupFilesystemErrorCode(error: unknown): string | undefined {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

function readDryRunProjectLocations(
  databasePath: string,
  openDatabase: typeof openConnection,
  allowUnavailableRegistry: boolean,
): RegisteredProjectLocation[] {
  let identity;
  try {
    identity = databaseFileIdentity(databasePath);
  } catch (error) {
    const code = setupFilesystemErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
  const database = openDatabase(databasePath, { readOnly: true, expectedFileIdentity: identity });
  let locations: RegisteredProjectLocation[] | undefined;
  let readFailed = false;
  let readError: unknown;
  try {
    locations = listRegisteredProjectLocations(database, { allowUnavailableRegistry });
  } catch (error) {
    readFailed = true;
    readError = error;
  }
  try {
    database.close();
  } catch (closeError) {
    if (readFailed) {
      throw new AggregateError(
        [readError, closeError],
        'Registered project discovery failed and closing the database connection also failed',
      );
    }
    throw closeError;
  }
  if (readFailed) throw readError;
  if (locations === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Registered project discovery produced no result');
  }
  return locations;
}

export async function setupGlobalClients(
  options: SetupOptions = {},
  dependencyOverrides: SetupCommandDependencies = {},
): Promise<SetupResult> {
  const dependencies: Required<SetupCommandDependencies> = {
    atomicWriteTextIfUnchanged: dependencyOverrides.atomicWriteTextIfUnchanged ?? atomicWriteTextIfUnchanged,
    unlinkRegularFileIfUnchanged: dependencyOverrides.unlinkRegularFileIfUnchanged ?? unlinkRegularFileIfUnchanged,
    beforeCommit: dependencyOverrides.beforeCommit ?? (() => undefined),
    openConnection: dependencyOverrides.openConnection ?? openConnection,
    ensureGlobalWorkspace: dependencyOverrides.ensureGlobalWorkspace ?? ensureGlobalWorkspace,
    refreshRegisteredProjectAgentFiles: dependencyOverrides.refreshRegisteredProjectAgentFiles
      ?? refreshRegisteredProjectAgentFiles,
  };
  const pathEnvironment: PathEnvironment = {
    ...(options.platform === undefined ? {} : { platform: options.platform }),
    ...(options.env === undefined ? {} : { env: options.env }),
  };
  if (options.skillDiscoveryMode !== undefined && !isSkillDiscoveryMode(options.skillDiscoveryMode)) {
    throw new KiokukoError('VALIDATION_ERROR', 'skill discovery must be off, official, or community');
  }
  const replaceConflictingMcpServers = replacementClientSet(options.replaceConflictingMcpServers);
  const clients = options.clients ?? await detectInstalledClients(pathEnvironment);
  if (!Array.isArray(clients) || clients.some((client) => !SETUP_CLIENTS.includes(client))) {
    throw new KiokukoError('VALIDATION_ERROR', `clients must be a subset of: ${SETUP_CLIENTS.join(', ')}`);
  }
  const command = options.command ?? 'kiokuko';
  if (typeof command !== 'string' || command.trim().length === 0 || command.includes('\0')) {
    throw new KiokukoError('VALIDATION_ERROR', 'command must be a non-empty executable path or name');
  }
  const databasePath = options.databasePath ?? getGlobalDatabasePath(pathEnvironment);
  const standardSkills = options.standardSkills ?? true;
  const environment = options.env ?? process.env;
  const environmentSkillDiscoveryMode = options.skillDiscoveryMode === undefined
    && Object.prototype.hasOwnProperty.call(environment, SKILL_DISCOVERY_ENV)
    ? normalizeSkillDiscoveryMode(environment[SKILL_DISCOVERY_ENV])
    : undefined;
  const skillDiscoveryMode = options.skillDiscoveryMode ?? environmentSkillDiscoveryMode;
  const files: PlannedFile[] = [];
  const planning: SetupPlanningContext = { directories: new Map() };
  const hermesProfile = clients.includes('hermes')
    ? await resolveHermesProfilePaths(pathEnvironment)
    : undefined;

  if (clients.includes('codex')) {
    files.push(await planFile(
      planning,
      getCodexConfigPath(pathEnvironment),
      'codex',
      'mcp-config',
      (existing) => renderCodexMcpConfig(
        existing ?? '',
        command,
        skillDiscoveryMode,
        { replaceConflictingIdentity: replaceConflictingMcpServers.has('codex') },
      ),
    ));
    files.push(await planFile(planning, getCodexInstructionsPath(pathEnvironment), 'codex', 'instructions', (existing) => renderGlobalInstructions(existing ?? '')));
  }
  if (clients.includes('opencode')) {
    const selectedConfig = await openCodeConfigPath(planning, pathEnvironment);
    files.push(await planFile(
      planning,
      selectedConfig.path,
      'opencode',
      'mcp-config',
      (existing) => renderOpenCodeConfig(
        existing,
        command,
        skillDiscoveryMode,
        { replaceConflictingIdentity: replaceConflictingMcpServers.has('opencode') },
      ),
      selectedConfig.mustRemainAbsent,
    ));
    files.push(await planFile(planning, getOpenCodeInstructionsPath(pathEnvironment), 'opencode', 'instructions', (existing) => renderGlobalInstructions(existing ?? '')));
    files.push(await planLegacyOpenCodeGuardCleanup(planning, pathEnvironment));
  }
  if (clients.includes('claude')) {
    files.push(await planFile(
      planning,
      getClaudeMcpConfigPath(pathEnvironment),
      'claude',
      'mcp-config',
      (existing) => renderClaudeConfig(
        existing,
        command,
        skillDiscoveryMode,
        { replaceConflictingIdentity: replaceConflictingMcpServers.has('claude') },
      ),
    ));
    files.push(await planFile(planning, getClaudeInstructionsPath(pathEnvironment), 'claude', 'instructions', (existing) => renderGlobalInstructions(existing ?? '')));
    files.push(await planLegacyClaudeHookCleanup(planning, pathEnvironment));
  }
  if (clients.includes('hermes')) {
    if (hermesProfile === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Hermes profile was not bound during setup planning');
    files.push(await planFile(
      planning,
      hermesProfile.configPath,
      'hermes',
      'mcp-config',
      (existing) => renderHermesConfig(
        existing,
        command,
        skillDiscoveryMode,
        { replaceConflictingIdentity: replaceConflictingMcpServers.has('hermes') },
      ),
    ));
  }

  if (standardSkills) {
    const bundledFiles = await loadBundledStandardSkillFiles();
    for (const client of clients) {
      const skillsDirectory = await standardSkillDirectory(client, pathEnvironment, hermesProfile);
      for (const bundled of bundledFiles) {
        files.push(await planFile(
          planning,
          setupPathJoin(pathEnvironment, skillsDirectory, bundled.skillName, bundled.relativePath),
          client,
          'standard-skill',
          (existing) => renderStandardSkillFile(existing, bundled),
        ));
      }
    }
  }

  const result: SetupResult = {
    clients,
    databasePath,
    databaseAction: options.dryRun ? 'planned' : 'initialized',
    databaseBackupPath: null,
    appliedMigrations: [],
    recoveredEntries: 0,
    files: files
      .filter((file) => file.report)
      .map(({ path: filePath, action, purpose, client }) => ({ path: filePath, action, purpose, client })),
    projectAgentFiles: [],
    standardSkills,
    dryRun: options.dryRun ?? false,
    nextStep: setupNextStep(clients, standardSkills),
  };
  if (options.dryRun) {
    const registeredProjectLocations = readDryRunProjectLocations(
      databasePath,
      dependencies.openConnection,
      options.migrationsDirectory !== undefined,
    );
    result.projectAgentFiles = await dependencies.refreshRegisteredProjectAgentFiles(
      registeredProjectLocations,
      {
        databasePath,
        dryRun: true,
        ...(options.migrationsDirectory === undefined
          ? {}
          : { migrationsDirectory: options.migrationsDirectory }),
      },
    );
    return result;
  }

  const initialized = await initializeDatabase({
    databasePath,
    ...(options.migrationsDirectory === undefined ? {} : { migrationsDirectory: options.migrationsDirectory }),
  });
  result.databaseBackupPath = initialized.backupPath;
  result.appliedMigrations = initialized.applied;
  result.recoveredEntries = initialized.recoveredEntries;
  const database = dependencies.openConnection(databasePath);
  let registeredProjectLocations: RegisteredProjectLocation[] = [];
  let workspaceInitializationFailed = false;
  let workspaceInitializationError: unknown;
  try {
    dependencies.ensureGlobalWorkspace(database);
    registeredProjectLocations = listRegisteredProjectLocations(database, {
      allowUnavailableRegistry: options.migrationsDirectory !== undefined,
    });
  } catch (error) {
    workspaceInitializationFailed = true;
    workspaceInitializationError = error;
  }
  try {
    database.close();
  } catch (closeError) {
    if (workspaceInitializationFailed) {
      throw new AggregateError(
        [workspaceInitializationError, closeError],
        'Global workspace initialization failed and closing the database connection also failed',
      );
    }
    throw closeError;
  }
  if (workspaceInitializationFailed) throw workspaceInitializationError;

  const applied: AppliedFileMutation[] = [];
  const createdDirectories: PlannedDirectory[] = [];
  try {
    await dependencies.beforeCommit();
    await preparePlannedDirectories(files, createdDirectories);
    await assertPlannedFiles(files);
    for (const file of files) {
      if (file.action === 'unchanged') continue;
      // Record a committed mutation before inspecting its cleanup outcome so
      // rollback never loses ownership of a target that already changed.
      let installed: RegularFileSnapshot | undefined;
      if (file.action === 'deleted') {
        if (file.original === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Setup deletion plan is missing original content');
        let outcome;
        try {
          outcome = await dependencies.unlinkRegularFileIfUnchanged(file.path, fileExpectation(file, file.original));
        } catch (error) {
          if (error instanceof AtomicCommittedUnlinkError) {
            applied.push({ file, installed: undefined });
          }
          throw error;
        }
        applied.push({ file, installed: undefined });
        assertAtomicCleanupComplete(outcome);
      } else {
        if (file.content === undefined) throw new KiokukoError('INTEGRITY_ERROR', 'Setup file plan is missing rendered content');
        let outcome;
        try {
          outcome = await dependencies.atomicWriteTextIfUnchanged(
            file.path,
            file.content,
            fileExpectation(file, file.original),
            file.mode,
          );
        } catch (error) {
          if (error instanceof AtomicCommittedMutationError) {
            applied.push({ file, installed: error.outcome.installed });
          } else if (error instanceof AtomicCommittedUnlinkError) {
            applied.push({ file, installed: undefined });
          }
          throw error;
        }
        installed = outcome.installed;
        applied.push({ file, installed });
        assertAtomicCleanupComplete(outcome);
      }
    }
    await assertPlannedFiles(files, applied);
  } catch (error) {
    const restorationFailures = await restoreFiles(applied, dependencies);
    const directoryRestorationFailures = await removeCreatedDirectories(createdDirectories);
    const failures = [...restorationFailures, ...directoryRestorationFailures];
    if (failures.length > 0) {
      throw new AggregateError(
        [error, ...failures],
        'Setup failed and filesystem restoration also failed',
      );
    }
    throw error;
  }
  result.projectAgentFiles = await dependencies.refreshRegisteredProjectAgentFiles(
    registeredProjectLocations,
    {
      databasePath,
      ...(options.migrationsDirectory === undefined
        ? {}
        : { migrationsDirectory: options.migrationsDirectory }),
    },
  );
  return result;
}
