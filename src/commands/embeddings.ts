import type { Command } from 'commander';
import { KiokukoError } from '../errors.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { parseEmbeddingConfig } from '../embedding/config.js';
import { readEmbeddingStatus } from '../embedding/diagnostics.js';
import { createEmbeddingProfile } from '../embedding/profile.js';
import {
  activateEmbeddingProfile,
  enqueueAllCurrentEntryEmbeddingsInTransaction,
  readActiveEmbeddingProfile,
} from '../embedding/store.js';
import { createEmbeddingRuntime } from '../embedding/runtime.js';
import type {
  EmbeddingConfig,
  EmbeddingProvider,
  EmbeddingRuntime,
  VectorSearchBackend,
} from '../embedding/types.js';
import { successEnvelope } from '../serialization/envelope.js';
import { runEmbeddingSetup } from '../embedding/setup-service.js';
import type { ModelDownloader } from '../embedding/model-download.js';
import type { InstalledModel } from '../embedding/model-installation.js';
import type { PathEnvironment } from '../config/paths.js';

const MAX_SYNC_JOBS = 64;
const DRAIN_DEADLINE_MS = 120_000;
const LOCAL_SEMANTIC_INSTALL_COMMAND = 'npm install --global @askdkc/kiokuko --allow-scripts=onnxruntime-node,sharp,protobufjs';

export type EmbeddingsDatabaseRunner = <T>(operation: (
  database: SqliteDatabase,
  backend?: VectorSearchBackend,
) => T | Promise<T>) => Promise<T>;
export type EmbeddingsOutput = (
  json: boolean | undefined,
  operation: string,
  data: unknown,
  message: string,
  meta?: Record<string, unknown>,
) => void;

export type EmbeddingsOptionalRuntimeChecker = () => Promise<void>;

export interface EmbeddingsSignalSource {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface EmbeddingsCommandDependencies {
  readonly withDatabase: EmbeddingsDatabaseRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly optionalRuntimeChecker?: EmbeddingsOptionalRuntimeChecker;
  readonly provider?: EmbeddingProvider;
  readonly backend?: VectorSearchBackend;
  readonly output?: EmbeddingsOutput;
  readonly signals?: EmbeddingsSignalSource;
  readonly modelDownloader?: ModelDownloader;
  readonly modelInstaller?: (preset: typeof import('../embedding/presets/local-small.js').LOCAL_SMALL_PRESET, options: Parameters<typeof runEmbeddingSetup>[2]) => Promise<InstalledModel>;
  readonly pathEnvironment?: PathEnvironment;
}

async function checkOptionalRuntime(): Promise<void> {
  try {
    await Promise.all([
      import('@huggingface/hub'),
      import('@huggingface/transformers'),
    ]);
  } catch (error) {
    const cause = error instanceof Error ? `: ${error.message}` : '';
    throw new KiokukoError(
      'SERVICE_UNAVAILABLE',
      `Local semantic retrieval dependencies are unavailable${cause}. Run once:\n${LOCAL_SEMANTIC_INSTALL_COMMAND}`,
    );
  }
}

async function ensureOptionalRuntime(dependencies: EmbeddingsCommandDependencies): Promise<void> {
  try {
    await (dependencies.optionalRuntimeChecker ?? checkOptionalRuntime)();
  } catch (error) {
    if (error instanceof KiokukoError && error.code === 'SERVICE_UNAVAILABLE' && error.message.includes(LOCAL_SEMANTIC_INSTALL_COMMAND)) {
      throw error;
    }
    throw new KiokukoError(
      'SERVICE_UNAVAILABLE',
      `Local semantic retrieval dependencies are unavailable. Run once:\n${LOCAL_SEMANTIC_INSTALL_COMMAND}`,
    );
  }
}

interface DrainSummary {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly blocked: number;
  readonly remaining: number;
}

const processSignals: EmbeddingsSignalSource = {
  once: (signal, listener) => process.once(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
};

function positiveLimit(value: string | undefined): number {
  if (value === undefined || !/^\d+$/u.test(value)) {
    throw new KiokukoError('VALIDATION_ERROR', 'limit must be an integer between 1 and 64');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_SYNC_JOBS) {
    throw new KiokukoError('VALIDATION_ERROR', 'limit must be an integer between 1 and 64');
  }
  return parsed;
}

function embeddingConfig(environment: NodeJS.ProcessEnv | undefined): EmbeddingConfig | undefined {
  return environment === undefined ? undefined : parseEmbeddingConfig(environment);
}

function runtimeOptions(dependencies: EmbeddingsCommandDependencies): {
  provider?: EmbeddingProvider;
  backend?: VectorSearchBackend;
} {
  return {
    ...(dependencies.provider === undefined ? {} : { provider: dependencies.provider }),
    ...(dependencies.backend === undefined ? {} : { backend: dependencies.backend }),
  };
}

function runtimeDependencies(
  dependencies: EmbeddingsCommandDependencies,
  backend: VectorSearchBackend | undefined,
): EmbeddingsCommandDependencies {
  if (backend === undefined || dependencies.backend === backend) return dependencies;
  return { ...dependencies, backend };
}

async function withRuntime<T>(
  database: SqliteDatabase,
  config: EmbeddingConfig | undefined,
  dependencies: EmbeddingsCommandDependencies,
  operation: (runtime: EmbeddingRuntime) => Promise<T>,
): Promise<T> {
  const runtime = createEmbeddingRuntime(database, config, runtimeOptions(dependencies));
  const signals = dependencies.signals ?? processSignals;
  let interrupted = false;
  const interrupt = (): void => {
    interrupted = true;
    void runtime.close();
  };
  signals.once('SIGINT', interrupt);
  signals.once('SIGTERM', interrupt);
  try {
    const result = await operation(runtime);
    if (interrupted) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Embedding operation was interrupted');
    return result;
  } finally {
    try {
      await runtime.close();
    } finally {
      signals.off('SIGINT', interrupt);
      signals.off('SIGTERM', interrupt);
    }
  }
}

async function drainOnce(
  runtime: EmbeddingRuntime,
  workspace: string | undefined,
  maxJobs: number,
): Promise<DrainSummary> {
  return runtime.drain({
    maxJobs,
    deadlineMs: DRAIN_DEADLINE_MS,
    ...(workspace === undefined ? {} : { workspace }),
  });
}

async function drainAll(
  runtime: EmbeddingRuntime,
  workspace: string | undefined,
): Promise<DrainSummary> {
  let total: DrainSummary = { claimed: 0, completed: 0, failed: 0, blocked: 0, remaining: 0 };
  for (;;) {
    const result = await drainOnce(runtime, workspace, MAX_SYNC_JOBS);
    total = {
      claimed: total.claimed + result.claimed,
      completed: total.completed + result.completed,
      failed: total.failed + result.failed,
      blocked: total.blocked + result.blocked,
      remaining: result.remaining,
    };
    if (result.claimed === 0 || result.remaining === 0) return total;
  }
}

async function activate(
  dependencies: EmbeddingsCommandDependencies,
  replace: boolean,
): Promise<ReturnType<typeof activateEmbeddingProfile>> {
  const config = embeddingConfig(dependencies.environment);
  if (config === undefined) throw new KiokukoError('CONFLICT', 'Embedding activation requires an explicit setup or test configuration');
  const profile = createEmbeddingProfile(config);
  return dependencies.withDatabase((database) => activateEmbeddingProfile(database, profile, { replace }));
}

async function sync(
  dependencies: EmbeddingsCommandDependencies,
  workspace: string | undefined,
  limit: number,
): Promise<DrainSummary> {
  const config = embeddingConfig(dependencies.environment);
  return dependencies.withDatabase((database, backend) => withRuntime(
    database,
    config,
    runtimeDependencies(dependencies, backend),
    (runtime) => drainOnce(runtime, workspace, limit),
  ));
}

async function rebuild(
  dependencies: EmbeddingsCommandDependencies,
  workspace: string | undefined,
  wait: boolean,
): Promise<{ enqueued: number; drain?: DrainSummary }> {
  const enqueued = await dependencies.withDatabase((database) => {
    if (readActiveEmbeddingProfile(database) === null) {
      throw new KiokukoError('CONFLICT', 'No active embedding profile is configured');
    }
    return withImmediateTransaction(database, () => enqueueAllCurrentEntryEmbeddingsInTransaction(database, undefined, workspace));
  });
  if (!wait) return { enqueued };
  const config = embeddingConfig(dependencies.environment);
  const drain = await dependencies.withDatabase((database, backend) => withRuntime(
    database,
    config,
    runtimeDependencies(dependencies, backend),
    (runtime) => drainAll(runtime, workspace),
  ));
  return { enqueued, drain };
}

function defaultOutput(
  json: boolean | undefined,
  operation: string,
  data: unknown,
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(successEnvelope(operation, data, meta))}\n`);
    return;
  }
  process.stdout.write(`${message}\n`);
}

export function registerEmbeddingsCommands(cli: Command, dependencies: EmbeddingsCommandDependencies): Command {
  const output = dependencies.output ?? defaultOutput;
  const embeddings = cli.command('embeddings').description('Manage semantic memory embeddings');

  embeddings.command('setup')
    .description('Install and enable the pinned local semantic-search model')
    .option('--preset <name>', 'Embedding preset', 'local-small')
    .option('--yes', 'Confirm model download and vector generation')
    .option('--dry-run', 'Plan setup without downloading or mutating anything')
    .option('--offline', 'Use only an already verified local installation')
    .option('--replace', 'Replace a different active embedding profile')
    .option('--json', 'Emit one JSON response')
    .action(async (options: { preset: string; yes?: boolean; dryRun?: boolean; offline?: boolean; replace?: boolean; json?: boolean }) => {
      const dryRun = options.dryRun === true;
      const confirmed = options.yes === true;
      if (!dryRun && !confirmed) throw new KiokukoError('USAGE_ERROR', 'Embedding setup requires --yes in non-interactive mode');
      if (!dryRun) await ensureOptionalRuntime(dependencies);
      const data = await dependencies.withDatabase((database, backend) => runEmbeddingSetup(database, {
        presetId: options.preset,
        confirmed,
        dryRun,
        offline: options.offline === true,
        replace: options.replace === true,
      }, {
        ...(dependencies.pathEnvironment === undefined ? {} : dependencies.pathEnvironment),
        ...(dependencies.modelDownloader === undefined ? {} : { downloader: dependencies.modelDownloader }),
        ...(dependencies.modelInstaller === undefined ? {} : { installer: dependencies.modelInstaller }),
        ...(dependencies.provider === undefined ? {} : { provider: dependencies.provider }),
        ...(backend === undefined ? {} : { backendId: backend.id }),
      }));
      output(options.json, 'embeddings.setup', data, data.semanticEnabled ? 'Semantic retrieval enabled.' : 'Embedding setup plan created.');
    });

  embeddings.command('status')
    .description('Show embedding configuration and coverage without contacting the provider')
    .option('--json', 'Emit a JSON response')
    .action(async (options: { json?: boolean }) => {
      const config = embeddingConfig(dependencies.environment);
      const data = await dependencies.withDatabase((database, backend) => readEmbeddingStatus(database, config, backend ?? dependencies.backend));
      output(options.json, 'embeddings.status', data, `Embedding coverage: ${data.readyVectors}/${data.eligibleEntries} (${(data.coverageRatio * 100).toFixed(1)}%)`);
    });

  embeddings.command('activate')
    .description('Activate the embedding profile from the current environment')
    .option('--replace', 'Replace a different active profile')
    .option('--json', 'Emit a JSON response')
    .action(async (options: { replace?: boolean; json?: boolean }) => {
      const data = await activate(dependencies, options.replace === true);
      output(options.json, 'embeddings.activate', data, `${data.activated ? 'Activated' : 'Already active'} embedding profile ${data.profileId}; ${data.enqueued} jobs enqueued`);
    });

  embeddings.command('sync')
    .description('Process a bounded batch of pending embedding jobs')
    .option('--workspace <name>', 'Limit jobs to one workspace')
    .option('--limit <number>', 'Maximum jobs to process', String(MAX_SYNC_JOBS))
    .option('--json', 'Emit a JSON response')
    .action(async (options: { workspace?: string; limit?: string; json?: boolean }) => {
      const data = await sync(dependencies, options.workspace, positiveLimit(options.limit));
      output(options.json, 'embeddings.sync', data, `Embedding sync: ${data.completed} completed, ${data.failed} failed, ${data.blocked} blocked, ${data.remaining} remaining`);
    });

  embeddings.command('rebuild')
    .description('Re-enqueue current entries for the active embedding profile')
    .option('--workspace <name>', 'Limit rebuild to one workspace')
    .option('--wait', 'Process the queued jobs before returning')
    .option('--json', 'Emit a JSON response')
    .action(async (options: { workspace?: string; wait?: boolean; json?: boolean }) => {
      const data = await rebuild(dependencies, options.workspace, options.wait === true);
      const drain = data.drain;
      const message = drain === undefined
        ? `Embedding rebuild queued ${data.enqueued} jobs`
        : `Embedding rebuild queued ${data.enqueued} jobs; ${drain.completed} completed, ${drain.failed} failed, ${drain.blocked} blocked, ${drain.remaining} remaining`;
      output(options.json, 'embeddings.rebuild', data, message);
    });

  return embeddings;
}
