import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { removeManagedBlock } from '../agent-file/managed-block.js';
import {
  getClaudeConfigDirectory, getClaudeInstructionsPath, getClaudeMcpConfigPath, getClaudeSkillsDirectory,
  getCodexConfigPath, getCodexHome, getCodexInstructionsPath, getCodexSkillsDirectory,
  getDatabaseLockPath, getEmbeddingModelsDirectory, getEmbeddingSetupLockPath, getGlobalDatabasePath, getHermesRoot,
  getOpenCodeConfigDirectory, getOpenCodeInstructionsPath, getOpenCodeSkillsDirectory,
  getPlatformDataDirectory, getRuntimeDescriptorPath, getRuntimeDirectory, type PathEnvironment,
} from '../config/paths.js';
import { parseProjectConfigText } from '../config/project-config.js';
import { databaseFileIdentity } from '../db/connection.js';
import { inspectDatabaseWithoutSideEffects } from '../db/inspection-snapshot.js';
import { KiokukoError } from '../errors.js';
import { acquireInstanceLock, isPidAlive } from '../server/instance-lock.js';
import { removeDelimitedBlock } from '../setup/managed-text.js';
import { setupMcpIdentityConflictClient } from '../setup/mcp-conflict.js';
import { listRegisteredProjectLocations } from '../setup/project-agent-refresh.js';
import { GLOBAL_INSTRUCTIONS_BEGIN, GLOBAL_INSTRUCTIONS_END, removeCodexMcpConfig } from '../setup/render.js';
import { STANDARD_SKILL_MANIFESTS } from '../setup/standard-skills.js';
import { successEnvelope } from '../serialization/envelope.js';
import { promptCheckboxes, supportsKeyboardSelection } from '../terminal/checkbox.js';
import {
  applyTextRemoval, assertDataFiles, assertTextRemovals, inventoryOwnedTree, planTextRemoval,
  removeDataFile, removeEmptyDirectories, safeStat,
  type DataFileRemoval, type EmptyDirectoryRemoval, type TextRemoval, type UninstallFileResult,
} from '../uninstall/files.js';
import { removeBindingIgnore, removeHermesMcpConfig, removeJsonMcpConfig, removeLegacyHooks } from '../uninstall/render.js';
import { getServerStatus } from './server-status.js';
import { parseSetupClients, SETUP_CLIENTS, setupClientLabel, type SetupClient } from './setup.js';

export interface UninstallOptions extends PathEnvironment { dryRun?: boolean; clients?: readonly SetupClient[] }
export interface UninstallResult {
  dryRun: boolean;
  clients: SetupClient[];
  scope: 'all' | 'clients' | 'none';
  files: UninstallFileResult[];
  missingProjects: string[];
  npmCommand: string | null;
}
export interface UninstallDependencies {
  beforeCommit?: () => void | Promise<void>;
  applyTextRemoval?: typeof applyTextRemoval;
}

interface UninstallPlan {
  text: TextRemoval[];
  data: DataFileRemoval[];
  directories: EmptyDirectoryRemoval[];
  preserved: UninstallFileResult[];
  missingProjects: string[];
}

function removeInstructions(source: string): string | undefined {
  return removeDelimitedBlock(source, GLOBAL_INSTRUCTIONS_BEGIN, GLOBAL_INSTRUCTIONS_END, 'Global instructions');
}

async function planText(plan: UninstallPlan, target: string, render: (source: string) => string | undefined): Promise<void> {
  const file = await planTextRemoval(target, render);
  if (file !== undefined) plan.text.push(file);
}

/** Unknown MCP identities are outside uninstall ownership; retain their exact source. */
async function planMcpConfig(plan: UninstallPlan, target: string, render: (source: string) => string | undefined): Promise<void> {
  await planText(plan, target, source => {
    try { return render(source); }
    catch (error) {
      const client = setupMcpIdentityConflictClient(error);
      if (client === undefined) throw error;
      plan.preserved.push({ path: target, action: 'preserved', reason: `unrecognized ${client} Kiokuko MCP entry; excluded from uninstall` });
      return source;
    }
  });
}

async function planEmptyDirectory(plan: UninstallPlan, target: string): Promise<void> {
  const info = await safeStat(target);
  if (info?.isDirectory()) plan.directories.push({ path: target, identity: { device: info.dev, inode: info.ino } });
}

async function planSkills(plan: UninstallPlan, skillsDirectory: string): Promise<void> {
  const manifests = [...STANDARD_SKILL_MANIFESTS, {
    name: 'kiokuko-enno-oduno', managedMarker: '<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-enno-oduno -->',
  }];
  for (const skill of manifests) {
    const files: DataFileRemoval[] = [];
    // This is a bounded walk of a known Kiokuko skill directory, including retired references.
    await inventoryOwnedTree(path.join(skillsDirectory, skill.name), files, plan.directories);
    for (const file of files) {
      if (!file.path.endsWith('.md')) {
        plan.preserved.push({ path: file.path, action: 'preserved', reason: 'not a bundled Markdown skill file' });
        continue;
      }
      await planText(plan, file.path, source => {
        if (source.split(skill.managedMarker).length === 2) return undefined;
        plan.preserved.push({ path: file.path, action: 'preserved', reason: 'no unique Kiokuko management marker' });
        return source;
      });
    }
  }
}

async function hermesHomes(options: PathEnvironment): Promise<string[]> {
  const selected = getHermesRoot(options);
  const root = path.basename(path.dirname(selected)) === 'profiles' ? path.dirname(path.dirname(selected)) : selected;
  const homes = new Set([root, selected]);
  const profiles = path.join(root, 'profiles');
  const info = await safeStat(profiles);
  if (info !== undefined) {
    if (!info.isDirectory()) throw new KiokukoError('VALIDATION_ERROR', 'Hermes profiles path is not a directory');
    const names = await readdir(profiles);
    if (names.length > 1_000) throw new KiokukoError('VALIDATION_ERROR', 'Too many Hermes profiles to uninstall');
    for (const name of names.sort()) {
      const home = path.join(profiles, name);
      if ((await safeStat(home))?.isDirectory()) homes.add(home);
    }
  }
  return [...homes];
}

async function planClients(plan: UninstallPlan, options: PathEnvironment, clients: readonly SetupClient[]): Promise<void> {
  const skills = new Set<string>();
  if (clients.includes('codex')) {
    await planMcpConfig(plan, getCodexConfigPath(options), removeCodexMcpConfig);
    await planText(plan, getCodexInstructionsPath(options), removeInstructions);
    await planText(plan, path.join(getCodexHome(options), 'hooks.json'), source => removeLegacyHooks(source, 'codex'));
    skills.add(getCodexSkillsDirectory(options));
  }
  if (clients.includes('claude')) {
    await planMcpConfig(plan, getClaudeMcpConfigPath(options), source => removeJsonMcpConfig(source, 'claude'));
    await planText(plan, getClaudeInstructionsPath(options), removeInstructions);
    await planText(plan, path.join(getClaudeConfigDirectory(options), 'settings.json'), source => removeLegacyHooks(source, 'claude'));
    skills.add(getClaudeSkillsDirectory(options));
  }
  if (clients.includes('opencode')) {
    const openCode = getOpenCodeConfigDirectory(options);
    for (const name of ['opencode.json', 'opencode.jsonc']) {
      await planMcpConfig(plan, path.join(openCode, name), source => removeJsonMcpConfig(source, 'opencode'));
    }
    await planText(plan, getOpenCodeInstructionsPath(options), removeInstructions);
    for (const [name, marker] of [
      ['kiokuko-enno-oduno.js', '// Managed by `kiokuko setup`: Enno-Oduno v1'],
      ['kiokuko-loop-guard.js', '// Managed by `kiokuko setup`: OpenCode loop guard v1'],
    ]) {
      await planText(plan, path.join(openCode, 'plugins', name!), source => {
        if (!source.startsWith(`${marker}\n`) && !source.startsWith(`${marker}\r\n`)) {
          throw new KiokukoError('CONFLICT', `Unmanaged file at retired Kiokuko plugin path: ${name}`);
        }
        return undefined;
      });
    }
    skills.add(getOpenCodeSkillsDirectory(options));
  }
  if (clients.includes('hermes')) {
    for (const home of await hermesHomes(options)) {
      await planMcpConfig(plan, path.join(home, 'config.yaml'), removeHermesMcpConfig);
      skills.add(path.join(home, 'skills'));
    }
  }
  for (const directory of skills) await planSkills(plan, directory);
}

async function planProjects(plan: UninstallPlan, databasePath: string): Promise<void> {
  if (await safeStat(databasePath) === undefined) return;
  // SQLite read-only connections can update SHM. Inspect an isolated DB/WAL copy instead.
  const locations = await inspectDatabaseWithoutSideEffects(databasePath, databaseFileIdentity(databasePath), listRegisteredProjectLocations);
  for (const location of locations) {
    if (await safeStat(location.repositoryRoot) === undefined) {
      plan.missingProjects.push(location.repositoryRoot);
      continue;
    }
    let agentFile = 'AGENTS.md';
    const binding = await planTextRemoval(path.join(location.repositoryRoot, '.kiokuko.json'), source => {
      const config = parseProjectConfigText(source);
      if (config.repositoryId !== location.repositoryId || config.workspace !== location.workspace) {
        throw new KiokukoError('CONFLICT', `Project binding no longer matches the registry: ${location.repositoryRoot}`);
      }
      agentFile = config.agentFile;
      return undefined;
    });
    await planText(plan, path.join(location.repositoryRoot, agentFile), source => removeManagedBlock(source).content);
    await planText(plan, path.join(location.repositoryRoot, '.gitignore'), removeBindingIgnore);
    // Keep the custom agent-file path until its cleanup succeeds, so retries can find it.
    if (binding !== undefined) plan.text.push(binding);
  }
}

async function assertStopped(options: PathEnvironment): Promise<void> {
  const descriptorPath = getRuntimeDescriptorPath(options);
  await safeStat(descriptorPath);
  if ((await getServerStatus({ descriptorPath })).running) {
    throw new KiokukoError('CONFLICT', 'Kiokuko is running. Stop Kiokuko clients and the foreground kiokuko serve process, then rerun uninstall.');
  }
  const lockPath = getDatabaseLockPath(getGlobalDatabasePath(options), options);
  let pid: number | undefined;
  await planTextRemoval(lockPath, source => {
    const lock = JSON.parse(source) as { pid?: unknown };
    if (!Number.isSafeInteger(lock?.pid) || Number(lock.pid) <= 0) throw new KiokukoError('CONFLICT', `Invalid Kiokuko instance lock: ${lockPath}`);
    pid = Number(lock.pid);
    return source;
  });
  if (pid !== undefined && await isPidAlive(pid)) throw new KiokukoError('CONFLICT', 'A live Kiokuko instance owns the database. Stop it before uninstalling.');
  if (await safeStat(getEmbeddingSetupLockPath(options)) !== undefined) {
    throw new KiokukoError('CONFLICT', `Embedding setup is active or left a lock. Finish setup before uninstalling: ${getEmbeddingSetupLockPath(options)}`);
  }
}

/** Remove installed Kiokuko artifacts; npm removal is returned as a final manual command. */
export async function uninstallKiokuko(options: UninstallOptions = {}, dependencies: UninstallDependencies = {}): Promise<UninstallResult> {
  const requested = options.clients === undefined ? SETUP_CLIENTS : options.clients;
  if (!Array.isArray(requested) || requested.some(client => !SETUP_CLIENTS.includes(client))) {
    throw new KiokukoError('VALIDATION_ERROR', `clients must be a subset of: ${SETUP_CLIENTS.join(', ')}`);
  }
  const clients = SETUP_CLIENTS.filter(client => requested.includes(client));
  const full = clients.length === SETUP_CLIENTS.length;
  const result: UninstallResult = {
    dryRun: options.dryRun === true,
    clients,
    scope: full ? 'all' : clients.length > 0 ? 'clients' : 'none',
    files: [],
    missingProjects: [],
    npmCommand: full ? 'npm uninstall --global kiokuko' : null,
  };
  if (clients.length === 0) return result;
  const plan: UninstallPlan = { text: [], data: [], directories: [], preserved: [], missingProjects: [] };
  const databasePath = getGlobalDatabasePath(options);
  await assertStopped(options);
  await planClients(plan, options, clients);
  if (full) {
    await planProjects(plan, databasePath);
    await inventoryOwnedTree(getEmbeddingModelsDirectory(options), plan.data, plan.directories);
    await planEmptyDirectory(plan, path.dirname(getEmbeddingModelsDirectory(options)));
    // Known filenames only: KIOKUKO_DATA_DIR may also contain user-owned files.
    for (const target of [getRuntimeDescriptorPath(options), `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`, databasePath]) {
      const info = await safeStat(target);
      if (info === undefined) continue;
      if (!info.isFile()) throw new KiokukoError('SECURITY_REJECTION', `Uninstall expected a data file: ${target}`);
      plan.data.push({ path: target, original: info });
    }
    await planEmptyDirectory(plan, getPlatformDataDirectory(options));
    await planEmptyDirectory(plan, getRuntimeDirectory(options));
  }
  const hasDatabase = plan.data.some(file => file.path === databasePath);
  if (full && !hasDatabase) await planText(plan, getDatabaseLockPath(databasePath, options), () => undefined);
  result.files = [
    ...plan.text.map(file => ({ path: file.path, action: file.content === undefined ? 'deleted' as const : 'updated' as const })),
    ...plan.data.map(file => ({ path: file.path, action: 'deleted' as const })),
    ...plan.preserved,
  ];
  result.missingProjects = plan.missingProjects;
  if (options.dryRun) return result;
  await dependencies.beforeCommit?.();
  await assertStopped(options);
  await assertTextRemovals(plan.text);
  await assertDataFiles(plan.data);
  const lock = hasDatabase ? await acquireInstanceLock(databasePath, options) : undefined;
  const completed: UninstallFileResult[] = [];
  const failures: unknown[] = [];
  try {
    if (full) await planEmptyDirectory(plan, getRuntimeDirectory(options));
    for (const file of plan.text) {
      await (dependencies.applyTextRemoval ?? applyTextRemoval)(file);
      completed.push({ path: file.path, action: file.content === undefined ? 'deleted' : 'updated' });
    }
    for (const file of plan.data) {
      await removeDataFile(file);
      completed.push({ path: file.path, action: 'deleted' });
    }
  } catch (cause) {
    failures.push(cause);
  }
  try {
    if (lock !== undefined && !await lock.release()) throw new KiokukoError('CONFLICT', 'Uninstall lost ownership of its instance lock');
  } catch (cause) { failures.push(cause); }
  if (failures.length === 0) {
    try { result.files.push(...await removeEmptyDirectories(plan.directories)); }
    catch (cause) { failures.push(cause); }
  }
  if (failures.length > 0) {
    const reasons = failures.map(cause => cause instanceof Error ? cause.message : 'Filesystem operation failed');
    throw new KiokukoError('PARTIAL_FAILURE', `Uninstall did not complete: ${reasons.join('; ')}. Keep the npm package and rerun uninstall after resolving this problem.`, { completed, reasons });
  }
  return result;
}

export interface UninstallPromptOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export async function promptUninstallClients(options: UninstallPromptOptions = {}): Promise<SetupClient[]> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (!supportsKeyboardSelection(input, output)) {
    throw new KiokukoError('USAGE_ERROR', 'Uninstall selection requires a terminal. Specify --clients codex,opencode,claude,hermes or --all.');
  }
  return promptCheckboxes(input, output, SETUP_CLIENTS.map(client => ({ value: client, label: setupClientLabel(client) })), {
    selected: [],
    heading: 'Select agents to remove Kiokuko from (none selected):\nSelecting ALL agents also permanently deletes shared memory, models and project bindings.\nSelecting only some agents keeps shared data and the npm package.',
    cancelMessage: 'Uninstall selection cancelled. No files changed.',
  });
}

export function registerUninstallCommand(cli: Command, environment: PathEnvironment = {}, promptOptions: UninstallPromptOptions = {}): void {
  cli.command('uninstall')
    .description('Choose agents to remove Kiokuko from; selecting all also deletes shared memory and models')
    .option('--clients <clients>', 'Remove integrations for a comma-separated subset of codex,opencode,claude,hermes', parseSetupClients)
    .option('--all', 'Remove all integrations and shared data without prompting')
    .option('--dry-run', 'Show planned removals without changing files')
    .option('--json', 'Emit a JSON response')
    .action(async (options: { clients?: SetupClient[]; all?: boolean; dryRun?: boolean; json?: boolean }) => {
      if (options.all && options.clients !== undefined) throw new KiokukoError('USAGE_ERROR', 'Use either --all or --clients, not both.');
      const input = promptOptions.input ?? process.stdin;
      const output = promptOptions.output ?? process.stdout;
      let clients = options.all ? [...SETUP_CLIENTS] : options.clients;
      if (clients === undefined) {
        if (options.dryRun && (options.json || !supportsKeyboardSelection(input, output))) clients = [...SETUP_CLIENTS];
        else if (options.json) throw new KiokukoError('USAGE_ERROR', 'Uninstall with --json requires --clients or --all.');
        else clients = await promptUninstallClients({ input, output });
      }
      if (!options.json && clients.length > 0) {
        output.write(options.dryRun ? 'Planning removals...\n' : `Removing Kiokuko from: ${clients.map(setupClientLabel).join(', ')}...\n`);
      }
      const result = await uninstallKiokuko({ ...environment, clients, dryRun: options.dryRun === true });
      if (options.json) { output.write(`${JSON.stringify(successEnvelope('uninstall', result))}\n`); return; }
      if (result.scope === 'none') { output.write('No agents selected. No files changed.\n'); return; }
      output.write(result.dryRun ? 'Kiokuko uninstall plan (no files changed):\n' : `Kiokuko removed from: ${result.clients.map(setupClientLabel).join(', ')}\n`);
      for (const file of result.files) output.write(`  ${file.action}: ${file.path}${file.reason ? ` (${file.reason})` : ''}\n`);
      for (const root of result.missingProjects) output.write(`  missing project: ${root}\n`);
      if (result.scope === 'clients') output.write('\nShared memory, models and project bindings are retained. Keep the npm package for the remaining agents.\n');
      if (result.dryRun) output.write(`\nRun kiokuko uninstall ${result.scope === 'all' ? '--all' : `--clients ${result.clients.join(',')}`} to apply this plan.\n`);
      else if (result.npmCommand !== null) output.write(`\nFinally, remove the npm package:\n${result.npmCommand}\n`);
    });
}
