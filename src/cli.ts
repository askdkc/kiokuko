import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Command, CommanderError } from 'commander';
import { initializeDatabase } from './commands/init.js';
import { useRepository } from './commands/use.js';
import { searchEntries, recallEntries } from './memory/retrieval.js';
import { readEntry, recordEntry } from './memory/entries.js';
import { promoteEntry, supersedeEntry, linkEntries } from './memory/lifecycle.js';
import { purgeEntry } from './commands/purge.js';
import { createBackup } from './commands/backup.js';
import { runDoctor } from './commands/doctor.js';
import { writeExport } from './commands/export.js';
import { importWorkspace } from './commands/import.js';
import { openConnection } from './db/connection.js';
import { errorEnvelope, successEnvelope } from './serialization/envelope.js';
import { KiokukoError, exitCodeFor } from './errors.js';
import { startWebServer } from './web/server.js';
import { registerServerCommands, type ServerCommandDependencies } from './commands/server.js';
import { registerAgentCommand, type AgentCommandDependencies } from './commands/agent.js';
import { registerLedgerCommands } from './commands/ledger.js';
import type { SqliteDatabase } from './db/adapter.js';
import { answerAkinator, getAkinatorContext, startAkinator } from './akinator/orchestrator.js';
import { parseSetupClients, setupGlobalClients } from './commands/setup.js';
import { runMcpServer } from './mcp/server.js';
import { runCuratorCommand } from './commands/curator.js';
import { globalizeCuratorCandidate } from './memory/curator.js';

const packageMetadata = createRequire(import.meta.url)('../package.json') as { version?: unknown };
if (typeof packageMetadata.version !== 'string' || packageMetadata.version.length === 0) {
  throw new Error('Kiokuko package version is unavailable');
}
const packageVersion = packageMetadata.version;

async function readJsonInput(filePath: string): Promise<unknown> {
  const text = filePath === '-' ? await new Promise<string>((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => { value += chunk; });
    process.stdin.on('end', () => resolve(value));
    process.stdin.on('error', reject);
  }) : await readFile(filePath, 'utf8');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new KiokukoError('VALIDATION_ERROR', 'Input is not valid JSON');
  }
}

async function withDatabase<T>(operation: (database: SqliteDatabase) => T | Promise<T>): Promise<T> {
  const result = await initializeDatabase();
  const database = openConnection(result.databasePath);
  try {
    return await operation(database);
  } finally {
    database.close();
  }
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function humanOrJson(json: boolean | undefined, operation: string, data: unknown, message: string, meta?: Record<string, unknown>): void {
  if (json) emit(successEnvelope(operation, data, meta));
  else process.stdout.write(`${message}\n`);
}

function parseExpectedRevision(value: string | undefined): number {
  if (value === undefined) throw new KiokukoError('USAGE_ERROR', '--expected-revision is required');
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 1) throw new KiokukoError('VALIDATION_ERROR', 'expected revision must be a positive integer');
  return revision;
}

function addWorkspaceOptions(command: Command): Command {
  return command.option('--workspace <name>', 'Workspace name').option('--json', 'Emit a JSON response');
}

export interface CliDependencies {
  readonly server?: ServerCommandDependencies;
  readonly agent?: AgentCommandDependencies;
}

async function dispatchRequest(request: unknown): Promise<unknown> {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) throw new KiokukoError('VALIDATION_ERROR', 'Request must be a JSON object');
  const value = request as Record<string, unknown>;
  if (value.apiVersion !== '1') throw new KiokukoError('VALIDATION_ERROR', 'apiVersion must be "1"');
  if (typeof value.operation !== 'string' || value.operation.length === 0) throw new KiokukoError('VALIDATION_ERROR', 'operation must be a non-empty string');
  const args = typeof value.arguments === 'object' && value.arguments !== null && !Array.isArray(value.arguments) ? value.arguments as Record<string, unknown> : {};
  const operation = value.operation;
  if (operation === 'init') return initializeDatabase();
  if (operation === 'use') return useRepository(args as never);
  if (operation === 'record') return withDatabase((database) => recordEntry(database, args as never));
  if (operation === 'read') return withDatabase((database) => readEntry(database, { workspace: String(args.workspace ?? ''), entryId: String(args.entryId ?? '') }));
  if (operation === 'search') return withDatabase((database) => searchEntries(database, args as never));
  if (operation === 'recall') return withDatabase((database) => recallEntries(database, args as never));
  if (operation === 'curator') return withDatabase((database) => runCuratorCommand(database, {
    ...(typeof args.workspace === 'string' ? { workspace: args.workspace } : {}),
    ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}),
    ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
    ...(typeof args.entryId === 'string' ? { entryId: args.entryId } : {}),
    yes: args.yes === true,
    json: true,
  }));
  if (operation === 'curator_globalize') return withDatabase((database) => globalizeCuratorCandidate(database, {
    workspace: String(args.workspace ?? ''),
    entryId: String(args.entryId ?? ''),
    expectedRevision: Number(args.expectedRevision),
    ...(typeof args.actor === 'string' ? { actor: args.actor } : {}),
  }));
  if (operation === 'guide_start') return withDatabase((database) => startAkinator(database, {
    workspace: String(args.workspace ?? ''),
    task: String(args.task ?? ''),
  }));
  if (operation === 'guide_answer') return withDatabase((database) => answerAkinator(database, {
    workspace: String(args.workspace ?? ''),
    sessionId: String(args.sessionId ?? ''),
    questionId: String(args.questionId ?? '') as never,
    value: String(args.value ?? ''),
  }));
  if (operation === 'guide_context') return withDatabase((database) => getAkinatorContext(database, {
    workspace: String(args.workspace ?? ''),
    sessionId: String(args.sessionId ?? ''),
  }));
  if (operation === 'promote') return withDatabase((database) => promoteEntry(database, { workspace: String(args.workspace ?? ''), entryId: String(args.entryId ?? ''), expectedRevision: Number(args.expectedRevision) }));
  if (operation === 'supersede') return withDatabase((database) => supersedeEntry(database, { workspace: String(args.workspace ?? ''), oldEntryId: String(args.oldEntryId ?? ''), replacementEntryId: String(args.replacementEntryId ?? ''), expectedRevision: Number(args.expectedRevision) }));
  if (operation === 'link') return withDatabase((database) => { linkEntries(database, args as never); return { linked: true }; });
  if (operation === 'purge') return withDatabase((database) => { purgeEntry(database, { workspace: String(args.workspace ?? ''), entryId: String(args.entryId ?? ''), confirm: args.confirm === true }); return { purged: true }; });
  if (operation === 'export') {
    const workspace = String(args.workspace ?? '');
    const output = String(args.output ?? '');
    if (output.length === 0) throw new KiokukoError('VALIDATION_ERROR', 'export output is required');
    return withDatabase((database) => writeExport(database, { workspace, output }));
  }
  if (operation === 'import') {
    const input = String(args.input ?? '');
    if (input.length === 0) throw new KiokukoError('VALIDATION_ERROR', 'import input is required');
    const importOptions: Parameters<typeof importWorkspace>[1] = { input, dryRun: args.dryRun === true };
    if (typeof args.workspace === 'string') importOptions.workspace = args.workspace;
    return args.dryRun === true ? importWorkspace(undefined, importOptions) : withDatabase((database) => importWorkspace(database, importOptions));
  }
  if (operation === 'backup') {
    const output = String(args.output ?? '');
    if (output.length === 0) throw new KiokukoError('VALIDATION_ERROR', 'backup output is required');
    return createBackup(output);
  }
  if (operation === 'doctor') return runDoctor();
  throw new KiokukoError('VALIDATION_ERROR', `Unknown operation: ${operation}`);
}

export function buildCli(dependencies: CliDependencies = {}): Command {
  const cli = new Command();
  cli.name('kiokuko').description('Model-agnostic external memory for AI coding agents').version(packageVersion);
  cli.exitOverride();
  cli.configureOutput({ outputError: () => undefined });

  cli.command('version').description('Show the Kiokuko package version').action(() => {
    process.stdout.write(`${packageVersion}\n`);
  });

  cli.command('init').description('Initialize the global Kiokuko database').option('--json').action(async (options: { json?: boolean }) => {
    const result = await initializeDatabase();
    const backupNotice = result.backupPath === null ? '' : ` Pre-migration backup: ${result.backupPath}`;
    humanOrJson(options.json, 'init', result, `Kiokuko database initialized (version ${result.currentVersion}).${backupNotice}`);
  });

  cli.command('setup').description('Configure global Kiokuko memory for Codex, OpenCode, Claude Code, and Hermes Agent')
    .option('--clients <clients>', 'Comma-separated clients: codex,opencode,claude,hermes', 'codex,opencode,claude,hermes')
    .option('--command <path>', 'Kiokuko executable name or absolute path', 'kiokuko')
    .option('--dry-run', 'Validate and show planned changes without writing')
    .option('--opencode-capture <profile>', 'OpenCode evidence capture: off,minimal,standard', 'off')
    .option('--opencode-mode <mode>', 'OpenCode prepare enforcement: advisory,strict', 'advisory')
    .option('--json', 'Emit a JSON response')
    .action(async (options: { clients: string; command: string; dryRun?: boolean; json?: boolean; opencodeCapture: string; opencodeMode: string }) => {
      if (!['off', 'minimal', 'standard'].includes(options.opencodeCapture)) throw new KiokukoError('VALIDATION_ERROR', 'opencode capture must be off, minimal, or standard');
      if (!['advisory', 'strict'].includes(options.opencodeMode)) throw new KiokukoError('VALIDATION_ERROR', 'opencode mode must be advisory or strict');
      const data = await setupGlobalClients({
        clients: parseSetupClients(options.clients),
        command: options.command,
        dryRun: options.dryRun === true,
        opencodeCapture: options.opencodeCapture as 'off' | 'minimal' | 'standard',
        opencodeMode: options.opencodeMode as 'advisory' | 'strict',
      });
      const changed = data.files.filter((file) => file.action !== 'unchanged').length;
      const message = options.dryRun
        ? `Kiokuko setup plan for ${data.clients.join(', ')}: ${changed} file${changed === 1 ? '' : 's'} would change.`
        : `Kiokuko configured for ${data.clients.join(', ')} (${changed} file${changed === 1 ? '' : 's'} changed).${data.databaseBackupPath === null ? '' : ` Pre-migration backup: ${data.databaseBackupPath}.`} ${data.nextStep}`;
      humanOrJson(options.json, 'setup', data, message);
    });

  cli.command('mcp').description('Run the Kiokuko MCP server over stdio').action(async () => {
    await runMcpServer();
  });

  cli.command('use').description('Bind this repository to Kiokuko external memory')
    .option('--root <path>').option('--workspace <name>').option('--agent-file <path>', 'Agent instruction file', 'AGENTS.md')
    .option('--dry-run').option('--no-agent-file').option('--force-rebind').option('--allow-directory').option('--json')
    .action(async (options: Record<string, unknown>) => {
      const useOptions: Parameters<typeof useRepository>[0] = {};
      if (typeof options.root === 'string') useOptions.root = options.root;
      if (typeof options.workspace === 'string') useOptions.workspace = options.workspace;
      if (typeof options.agentFile === 'string') useOptions.agentFile = options.agentFile;
      if (options.dryRun === true) useOptions.dryRun = true;
      if (options.noAgentFile === true) useOptions.noAgentFile = true;
      if (options.forceRebind === true) useOptions.forceRebind = true;
      if (options.allowDirectory === true) useOptions.allowDirectory = true;
      const result = await useRepository(useOptions);
      humanOrJson(options.json === true, 'use', result, `Kiokuko enabled for ${result.repositoryRoot}`);
    });

  const recall = addWorkspaceOptions(cli.command('recall').description('Recall relevant memory entries').argument('<query>'))
    .option('--limit <number>', 'Maximum entries', '5').option('--max-chars <number>', 'Context character budget', '8000');
  recall.action(async (query: string, options: Record<string, unknown>) => {
    const data = await withDatabase((database) => recallEntries(database, {
      workspace: String(options.workspace ?? ''), query, limit: Number(options.limit), maxChars: Number(options.maxChars),
    }));
    humanOrJson(options.json === true, 'recall', data, `${data.items.length} memory entries recalled`, { count: data.count, truncated: data.truncated });
  });

  const guide = cli.command('guide').description('Run the Akinator-style knowledge and skill intake');
  guide.command('start').description('Start an intake session').argument('<task>').requiredOption('--workspace <name>').option('--json').action(async (task: string, options: { workspace: string; json?: boolean }) => {
    const data = await withDatabase((database) => startAkinator(database, { workspace: options.workspace, task }));
    humanOrJson(options.json, 'guide.start', data, data.question?.prompt ?? 'Akinator context is ready');
  });
  guide.command('answer').description('Answer the current intake question').argument('<session-id>').requiredOption('--workspace <name>').requiredOption('--question-id <id>').requiredOption('--value <value>').option('--json').action(async (sessionId: string, options: { workspace: string; questionId: string; value: string; json?: boolean }) => {
    const data = await withDatabase((database) => answerAkinator(database, {
      workspace: options.workspace,
      sessionId,
      questionId: options.questionId as never,
      value: options.value,
    }));
    humanOrJson(options.json, 'guide.answer', data, data.question?.prompt ?? 'Akinator context is ready');
  });
  guide.command('context').description('Build the knowledge and skill context for an intake session').argument('<session-id>').requiredOption('--workspace <name>')
    .option('--no-client-skills', 'Allow the mattpocock/skills fallback because the client has no available skills')
    .option('--json').action(async (sessionId: string, options: { workspace: string; clientSkills?: boolean; json?: boolean }) => {
    const data = await withDatabase((database) => getAkinatorContext(database, {
      workspace: options.workspace,
      sessionId,
      ...(options.clientSkills === false ? { allowExternalSkillFallback: true } : {}),
    }));
    humanOrJson(options.json, 'guide.context', data, `${data.entries.length} knowledge entries selected`);
  });

  const search = addWorkspaceOptions(cli.command('search').description('Search memory entries').argument('<query>'))
    .option('--limit <number>', 'Maximum entries', '20').option('--kind <kind>').option('--status <status>').option('--tag <tag>');
  search.action(async (query: string, options: Record<string, unknown>) => {
    const searchOptions: Parameters<typeof searchEntries>[1] = { workspace: String(options.workspace ?? ''), query, limit: Number(options.limit) };
    if (typeof options.kind === 'string') searchOptions.kind = options.kind as never;
    if (typeof options.status === 'string') searchOptions.status = options.status as never;
    if (typeof options.tag === 'string') searchOptions.tag = options.tag;
    const data = await withDatabase((database) => searchEntries(database, searchOptions));
    humanOrJson(options.json === true, 'search', data, `${data.items.length} memory entries found`, { count: data.count });
  });

  const read = addWorkspaceOptions(cli.command('read').description('Read one memory entry').argument('<entry-id>'));
  read.action(async (entryId: string, options: Record<string, unknown>) => {
    const data = await withDatabase((database) => readEntry(database, { workspace: String(options.workspace ?? ''), entryId }));
    humanOrJson(options.json === true, 'read', data, `${data.title}\n${data.body}`);
  });

  const record = cli.command('record').description('Record a memory entry').requiredOption('--workspace <name>').requiredOption('--input-json <file>').option('--json');
  record.action(async (options: { workspace: string; inputJson: string; json?: boolean }) => {
    const input = await readJsonInput(options.inputJson);
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new KiokukoError('VALIDATION_ERROR', 'record input must be a JSON object');
    const data = await withDatabase((database) => recordEntry(database, { ...(input as Record<string, unknown>), workspace: options.workspace } as never));
    humanOrJson(options.json, 'record', data, `Recorded ${data.id}`);
  });

  const promote = cli.command('promote').description('Promote a candidate entry').argument('<entry-id>').requiredOption('--workspace <name>').requiredOption('--expected-revision <number>').option('--json');
  promote.action(async (entryId: string, options: { workspace: string; expectedRevision: string; json?: boolean }) => {
    const data = await withDatabase((database) => promoteEntry(database, { workspace: options.workspace, entryId, expectedRevision: parseExpectedRevision(options.expectedRevision) }));
    humanOrJson(options.json, 'promote', data, `Promoted ${data.id}`);
  });

  const curator = cli.command('curator').description('Review reusable knowledge and add confirmed candidates to global memory')
    .option('--workspace <name>', 'Project workspace (defaults to the current repository)')
    .option('--cwd <path>', 'Repository path used when resolving the current workspace')
    .option('--entry-id <id>', 'Review one candidate entry')
    .option('--limit <number>', 'Maximum candidates to review', '10')
    .option('--skill-ready-only', 'Show only candidates backed by qualified independent Akinator runs')
    .option('--yes', 'Add every displayed candidate without interactive prompts')
    .option('--json', 'Emit candidates as JSON without changing memory');
  curator.action(async (options: { workspace?: string; cwd?: string; entryId?: string; limit: string; skillReadyOnly?: boolean; yes?: boolean; json?: boolean }) => {
    const data = await withDatabase((database) => runCuratorCommand(database, {
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      limit: Number(options.limit),
      ...(options.entryId === undefined ? {} : { entryId: options.entryId }),
      skillReadyOnly: options.skillReadyOnly === true,
      yes: options.yes === true,
      json: options.json === true,
    }));
    humanOrJson(options.json, 'curator', data, `${data.candidates.length} curator candidate${data.candidates.length === 1 ? '' : 's'} reviewed; ${data.globalized.length} added to global memory`);
  });

  const supersede = cli.command('supersede').description('Supersede an existing entry').argument('<old-entry-id>').requiredOption('--with <entry-id>').requiredOption('--workspace <name>').requiredOption('--expected-revision <number>').option('--json');
  supersede.action(async (oldEntryId: string, options: { with: string; workspace: string; expectedRevision: string; json?: boolean }) => {
    const data = await withDatabase((database) => supersedeEntry(database, { workspace: options.workspace, oldEntryId, replacementEntryId: options.with, expectedRevision: parseExpectedRevision(options.expectedRevision) }));
    humanOrJson(options.json, 'supersede', data, `Superseded ${data.id}`);
  });

  const link = cli.command('link').description('Link two memory entries').argument('<from-entry-id>').argument('<to-entry-id>').requiredOption('--workspace <name>').requiredOption('--relation <relation>').option('--json');
  link.action(async (fromEntryId: string, toEntryId: string, options: { workspace: string; relation: never; json?: boolean }) => {
    const data = await withDatabase((database) => { linkEntries(database, { workspace: options.workspace, fromEntryId, toEntryId, relation: options.relation }); return { linked: true }; });
    humanOrJson(options.json, 'link', data, `Linked ${fromEntryId} -> ${toEntryId}`);
  });

  const purge = cli.command('purge').description('Purge a memory entry').argument('<entry-id>').requiredOption('--workspace <name>').option('--confirm').option('--json');
  purge.action(async (entryId: string, options: { workspace: string; confirm?: boolean; json?: boolean }) => {
    const data = await withDatabase((database) => { purgeEntry(database, { workspace: options.workspace, entryId, confirm: options.confirm === true }); return { purged: true }; });
    humanOrJson(options.json, 'purge', data, `Purged ${entryId}`);
  });

  cli.command('backup').description('Create a database backup').requiredOption('--output <path>').option('--json').action(async (options: { output: string; json?: boolean }) => {
    const result = await createBackup(options.output);
    humanOrJson(options.json, 'backup', result, `Backup written to ${options.output}`);
  });

  cli.command('doctor').description('Check runtime and database health').option('--json').action(async (options: { json?: boolean }) => {
    const data = await runDoctor();
    humanOrJson(options.json, 'doctor', data, data.ok ? 'Kiokuko doctor: OK' : 'Kiokuko doctor: FAILED');
    if (!data.ok) process.exitCode = 8;
  });

  registerServerCommands(cli, dependencies.server);
  registerAgentCommand(cli, dependencies.agent);
  registerLedgerCommands(cli, { withDatabase });

  cli.command('web').description('Start the local Kiokuko web UI')
    .option('--host <host>', 'Loopback host', '127.0.0.1')
    .option('--port <number>', 'HTTP port', '4173')
    .option('--json')
    .action(async (options: { host: string; port: string; json?: boolean }) => {
      const web = await startWebServer({ host: options.host, port: Number(options.port) });
      humanOrJson(options.json, 'web', { url: web.url }, `Kiokuko Web: ${web.url}`);
      await new Promise<void>((resolve, reject) => {
        let stopping = false;
        const stop = () => {
          if (stopping) return;
          stopping = true;
          void web.close().then(resolve, reject);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });

  cli.command('export').description('Export workspace memory').requiredOption('--workspace <name>').requiredOption('--output <path>').option('--json').action(async (options: { workspace: string; output: string; json?: boolean }) => {
    const result = await withDatabase((database) => writeExport(database, { workspace: options.workspace, output: options.output }));
    humanOrJson(options.json, 'export', { output: options.output, count: result.count, checksum: result.checksum }, `Exported ${result.count} entries`);
  });

  cli.command('import').description('Import workspace memory').requiredOption('--input <path>').option('--workspace <name>').option('--dry-run').option('--json').action(async (options: { input: string; workspace?: string; dryRun?: boolean; json?: boolean }) => {
    const importOptions: Parameters<typeof importWorkspace>[1] = { input: options.input };
    if (options.workspace !== undefined) importOptions.workspace = options.workspace;
    if (options.dryRun) importOptions.dryRun = true;
    const data = options.dryRun
      ? await importWorkspace(undefined, importOptions)
      : await withDatabase((database) => importWorkspace(database, importOptions));
    humanOrJson(options.json, 'import', data, `${data.count} records inspected`);
  });

  cli.command('call').description('Process one JSON request').requiredOption('--input-json <file>').option('--json').action(async (options: { inputJson: string }) => {
    const request = await readJsonInput(options.inputJson);
    const operation = typeof request === 'object' && request !== null && !Array.isArray(request) && typeof (request as Record<string, unknown>).operation === 'string' ? (request as Record<string, unknown>).operation as string : 'unknown';
    const data = await dispatchRequest(request);
    emit(successEnvelope(operation, data));
  });

  return cli;
}

function operationFor(argv: string[]): string {
  const command = argv[2] ?? 'unknown';
  if (command === 'server' && argv[3] !== undefined && !argv[3].startsWith('-')) return `server.${argv[3]}`;
  if (command === 'agent' && argv[3] !== undefined && !argv[3].startsWith('-')) return `agent.${argv[3]}`;
  return command;
}

function commanderDiagnostic(error: CommanderError): string {
  if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') return '';
  return `Command line usage error (${error.code})\n`;
}

export async function runCli(argv: string[] = process.argv, dependencies: CliDependencies = {}): Promise<number> {
  let serveStarted = false;
  const serverDependencies: ServerCommandDependencies = {
    ...(dependencies.server ?? {}),
    onServeStarted: () => {
      serveStarted = true;
      dependencies.server?.onServeStarted?.();
    },
  };
  const cli = buildCli({ ...dependencies, server: serverDependencies });
  const jsonRequested = argv.includes('--json') || argv.includes('call');
  const operation = operationFor(argv);
  try {
    await cli.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      const diagnostic = commanderDiagnostic(error);
      if (diagnostic.length > 0) process.stderr.write(diagnostic);
      return error.exitCode === 0 ? 0 : 2;
    }
    if (jsonRequested && !(serveStarted && operation === 'serve')) emit(errorEnvelope(operation, error));
    else process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return exitCodeFor(error);
  }
}
