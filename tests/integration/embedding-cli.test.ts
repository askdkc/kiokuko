import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Command } from 'commander';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { registerEmbeddingsCommands } from '../../src/commands/embeddings.js';
import { KiokukoError } from '../../src/errors.js';
import { parseEmbeddingConfig, requireEnabledEmbeddingConfig } from '../../src/embedding/config.js';
import { createEmbeddingProfile } from '../../src/embedding/profile.js';
import { activateEmbeddingProfile } from '../../src/embedding/store.js';
import { recordEntry } from '../../src/memory/entries.js';
import type { EmbeddingProvider } from '../../src/embedding/types.js';

const timestamp = '2026-08-31T00:00:00.000Z';

async function temporaryDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(database);
  return database;
}

function command(database: ReturnType<typeof openConnection>, output: string[], options: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly provider?: EmbeddingProvider;
  readonly optionalRuntimeChecker?: () => Promise<void>;
} = {}): Command {
  const cli = new Command();
  cli.exitOverride();
  registerEmbeddingsCommands(cli, {
    withDatabase: async (operation) => operation(database),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.optionalRuntimeChecker === undefined ? {} : { optionalRuntimeChecker: options.optionalRuntimeChecker }),
    output: (json, operation, data, message) => {
      output.push(json ? JSON.stringify({ operation, data }) : message);
    },
  });
  return cli;
}

test('embedding setup checks optional runtime before opening the database', async () => {
  const database = await temporaryDatabase('embedding-cli-runtime');
  try {
    const output: string[] = [];
    let databaseCalls = 0;
    const checker = async () => {
      throw new Error('optional runtime is missing');
    };
    const cli = new Command();
    cli.exitOverride();
    registerEmbeddingsCommands(cli, {
      withDatabase: async () => {
        databaseCalls += 1;
        throw new Error('database must not be opened');
      },
      optionalRuntimeChecker: checker,
      output: (json, operation, data, message) => {
        output.push(json ? JSON.stringify({ operation, data }) : message);
      },
    });

    await assert.rejects(
      () => cli.parseAsync(['node', 'kiokuko', 'embeddings', 'setup', '--yes']),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'SERVICE_UNAVAILABLE'
        && error.message.includes('npm install --global @askdkc/kiokuko @huggingface/hub@2.16.1 @huggingface/transformers@4.2.0 sqlite-vec@0.1.9 --allow-scripts=onnxruntime-node,sharp,protobufjs'),
    );
    assert.equal(databaseCalls, 0);
    assert.deepEqual(output, []);
  } finally {
    database.close();
  }
});

test('embedding setup skips optional runtime checks during dry-run', async () => {
  const database = await temporaryDatabase('embedding-cli-dry-run');
  try {
    const output: string[] = [];
    let checks = 0;
    await command(database, output, {
      optionalRuntimeChecker: async () => {
        checks += 1;
      },
    }).parseAsync(['node', 'kiokuko', 'embeddings', 'setup', '--dry-run', '--json']);
    const response = JSON.parse(output[0]!) as { operation: string; data: { semanticEnabled: boolean } };
    assert.equal(response.operation, 'embeddings.setup');
    assert.equal(response.data.semanticEnabled, false);
    assert.equal(checks, 0);
  } finally {
    database.close();
  }
});

function environment(model: string): NodeJS.ProcessEnv {
  return {
    KIOKUKO_EMBEDDINGS: 'optional',
    KIOKUKO_EMBEDDING_BASE_URL: 'http://127.0.0.1:8080/v1',
    KIOKUKO_EMBEDDING_MODEL: model,
    KIOKUKO_EMBEDDING_DIMENSIONS: '3',
    KIOKUKO_EMBEDDING_DISTANCE_CEILING: '0.8',
  };
}

test('embedding status is bounded and provider-free when embeddings are off', async () => {
  const database = await temporaryDatabase('embedding-cli-status');
  try {
    const output: string[] = [];
    await command(database, output, { environment: { KIOKUKO_EMBEDDINGS: 'off' } }).parseAsync(['node', 'kiokuko', 'embeddings', 'status', '--json']);
    const response = JSON.parse(output[0]!) as { operation: string; data: Record<string, unknown> };
    assert.equal(response.operation, 'embeddings.status');
    assert.equal(response.data.mode, 'off');
    assert.equal(response.data.activeProfileId, null);
    assert.equal(response.data.queryCacheRows, 0);
    assert.equal('apiKey' in response.data, false);
    assert.equal('baseUrl' in response.data, false);
  } finally {
    database.close();
  }
});

test('activate enqueues without contacting the provider and sync consumes a bounded batch', async () => {
  const database = await temporaryDatabase('embedding-cli-sync');
  try {
    const config = requireEnabledEmbeddingConfig(parseEmbeddingConfig(environment('cli-model')));
    const profile = createEmbeddingProfile(config);
    recordEntry(database, {
      workspace: 'project:embedding-cli',
      kind: 'lesson',
      title: 'CLI entry',
      body: 'The CLI should queue and process this entry.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-cli', now: timestamp });
    let calls = 0;
    const provider: EmbeddingProvider = {
      profile: profile.identity,
      async embed(inputs) {
        calls += 1;
        return inputs.map(() => new Float32Array([1, 0, 0]));
      },
    };
    const output: string[] = [];
    await command(database, output, { environment: environment('cli-model'), provider })
      .parseAsync(['node', 'kiokuko', 'embeddings', 'activate', '--json']);
    const activation = JSON.parse(output.pop()!) as { data: { activated: boolean; enqueued: number } };
    assert.equal(activation.data.activated, true);
    assert.equal(activation.data.enqueued, 1);
    assert.equal(calls, 0);

    await command(database, output, { environment: environment('cli-model'), provider })
      .parseAsync(['node', 'kiokuko', 'embeddings', 'sync', '--limit', '1', '--json']);
    const sync = JSON.parse(output.pop()!) as { data: { completed: number; failed: number; remaining: number } };
    assert.equal(sync.data.completed, 1);
    assert.equal(sync.data.failed, 0);
    assert.equal(sync.data.remaining, 0);
    assert.equal(calls, 1);
  } finally {
    database.close();
  }
});

test('rebuild requires an active profile and can explicitly wait for the queued work', async () => {
  const database = await temporaryDatabase('embedding-cli-rebuild');
  try {
    const output: string[] = [];
    await assert.rejects(
      () => command(database, output, { environment: { KIOKUKO_EMBEDDINGS: 'off' } }).parseAsync(['node', 'kiokuko', 'embeddings', 'rebuild']),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
    );

    const config = requireEnabledEmbeddingConfig(parseEmbeddingConfig(environment('rebuild-model')));
    const profile = createEmbeddingProfile(config);
    activateEmbeddingProfile(database, profile, { replace: false, now: timestamp });
    recordEntry(database, {
      workspace: 'project:rebuild',
      kind: 'lesson',
      title: 'Rebuild entry',
      body: 'Rebuild waits only when explicitly requested.',
      createdBy: 'test',
    }, { idFactory: () => 'entry-rebuild', now: timestamp });
    const provider: EmbeddingProvider = {
      profile: profile.identity,
      async embed(inputs) {
        return inputs.map(() => new Float32Array([1, 0, 0]));
      },
    };
    await command(database, output, { environment: environment('rebuild-model'), provider })
      .parseAsync(['node', 'kiokuko', 'embeddings', 'rebuild', '--workspace', 'project:rebuild', '--wait', '--json']);
    const rebuild = JSON.parse(output.pop()!) as { data: { enqueued: number; drain: { completed: number; remaining: number } } };
    assert.equal(rebuild.data.enqueued, 1);
    assert.equal(rebuild.data.drain.completed, 1);
    assert.equal(rebuild.data.drain.remaining, 0);
  } finally {
    database.close();
  }
});
