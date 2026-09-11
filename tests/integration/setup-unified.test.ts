import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Command } from 'commander';
import { buildCli } from '../../src/cli.js';
import { registerEmbeddingsCommands, type EmbeddingsCommandDependencies } from '../../src/commands/embeddings.js';
import { setupGlobalClients } from '../../src/commands/setup.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { planEmbeddingSetup } from '../../src/embedding/setup-service.js';
import { recordEntry } from '../../src/memory/entries.js';

const entrypoints = [['setup'], ['embeddings', 'setup']];

function command(dependencies: EmbeddingsCommandDependencies) {
  const cli = new Command().exitOverride();
  registerEmbeddingsCommands(cli, dependencies);
  return cli;
}

for (const entrypoint of entrypoints) {
  test(`${entrypoint.join(' ')} enables embeddings by default and --no-embeddings preserves them`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-unified-'));
    const database = openConnection(':memory:');
    migrateDatabase(database);
    const calls: string[] = [];
    let result: Record<string, unknown> = {};
    let operation = '';
    const dependencies: EmbeddingsCommandDependencies = {
      pathEnvironment: { env: { HOME: root, KIOKUKO_DATA_DIR: root, PATH: '' } },
      optionalRuntimeChecker: async () => { calls.push('runtime'); },
      optionalRuntimeInstaller: async () => { assert.fail('runtime is already available'); },
      setupGlobalClients: async (options) => {
        calls.push('clients');
        assert.deepEqual(options.clients, ['codex']);
        return { clients: options.clients!, projectAgentFiles: [] };
      },
      withDatabase: async (run) => { calls.push('database'); return run(database); },
      modelInstaller: async () => {
        calls.push('model');
        return {
          installation: 'installed', directory: root,
          relativePath: 'models/embeddings/local-small/test',
          totalBytes: LOCAL_SMALL_PRESET.files.reduce((sum, file) => sum + file.size, 0),
          manifestHash: 'a'.repeat(64),
        };
      },
      provider: {
        profile: { providerKind: 'local-transformers' } as never,
        embed: async () => { assert.fail('empty database needs no vectors'); },
      },
      output: (_json, name, data) => { operation = name; result = data as Record<string, unknown>; },
    };
    try {
      await command(dependencies).parseAsync(['node', 'kiokuko', ...entrypoint, '--clients', 'codex', '--json']);
      assert.equal(operation, entrypoint.join('.'));
      assert.equal(result.semanticEnabled, true);
      assert.equal(result.embeddingsSkipped, false);
      assert.deepEqual(calls, ['runtime', 'clients', 'database', 'model']);
      const settings = database.prepare('SELECT * FROM embedding_settings').all();
      const profiles = database.prepare('SELECT * FROM embedding_profiles').all();
      calls.length = 0;
      await command(dependencies).parseAsync(['node', 'kiokuko', ...entrypoint, '--clients', 'codex', '--no-embeddings', '--json']);
      assert.deepEqual(calls, ['clients']);
      assert.equal(result.embeddingsSkipped, true);
      assert.equal('semanticEnabled' in result, false);
      assert.deepEqual(database.prepare('SELECT * FROM embedding_settings').all(), settings);
      assert.deepEqual(database.prepare('SELECT * FROM embedding_profiles').all(), profiles);
    } finally {
      database.close();
    }
  });

  test(`${entrypoint.join(' ')} --no-embeddings configures clients even when the embedding runtime is unavailable`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-unified-skip-'));
    const env = { HOME: path.join(root, 'home'), KIOKUKO_DATA_DIR: path.join(root, 'data'), PATH: '' };
    let result: Record<string, unknown> = {};
    const unavailable = async (): Promise<never> => { assert.fail('embedding work must be skipped'); };
    await command({
      pathEnvironment: { env },
      optionalRuntimeChecker: unavailable,
      optionalRuntimeInstaller: unavailable,
      withDatabase: unavailable,
      modelInstaller: unavailable,
      setupGlobalClients,
      output: (_json, _name, data) => { result = data as Record<string, unknown>; },
    }).parseAsync(['node', 'kiokuko', ...entrypoint, '--no-embeddings', '--no-standard-skills', '--clients', 'codex', '--json']);
    assert.equal(result.embeddingsSkipped, true);
    assert.match(await readFile(path.join(env.HOME, '.codex', 'config.toml'), 'utf8'), /mcp_servers\.kiokuko/);
    await access(path.join(env.KIOKUKO_DATA_DIR, 'kiokuko.sqlite3'));
    await assert.rejects(access(path.join(env.KIOKUKO_DATA_DIR, 'models')));
  });

  test(`${entrypoint.join(' ')} dry-run creates no database, settings, or models`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-unified-plan-'));
    const before = await readdir(root);
    let output = '';
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      await buildCli({ setupEnvironment: { env: { HOME: root, KIOKUKO_DATA_DIR: path.join(root, 'data'), PATH: '' } } })
        .parseAsync(['node', 'kiokuko', ...entrypoint, '--clients', 'codex', '--dry-run', '--json']);
    } finally {
      process.stdout.write = write;
    }
    const response = JSON.parse(output);
    assert.equal(response.operation, entrypoint.join('.'));
    assert.equal(response.data.embeddingsSkipped, false);
    assert.equal(response.data.databaseAction, 'planned');
    assert.equal(response.data.semanticEnabled, false);
    assert.ok(response.data.model.bytes > 0);
    assert.deepEqual(await readdir(root), before);
  });
}

test('setup validates client, discovery, and preset options before installation or writes', async () => {
  const noEffects = async (): Promise<never> => { assert.fail('invalid input must not cause effects'); };
  for (const flags of [['--clients', 'unknown'], ['--skill-discovery', 'unknown'], ['--preset', 'unknown']]) {
    await assert.rejects(command({
      optionalRuntimeChecker: noEffects,
      optionalRuntimeInstaller: noEffects,
      withDatabase: noEffects,
      setupGlobalClients: noEffects,
    }).parseAsync(['node', 'kiokuko', 'setup', ...flags, '--json']), { code: 'VALIDATION_ERROR' });
  }
});

test('setup --offline does not install a missing optional runtime', async () => {
  const noEffects = async (): Promise<never> => { assert.fail('offline runtime failure must not install or configure'); };
  await assert.rejects(command({
    optionalRuntimeChecker: async () => { throw new Error('missing runtime'); },
    optionalRuntimeInstaller: noEffects,
    withDatabase: noEffects,
    setupGlobalClients: noEffects,
  }).parseAsync(['node', 'kiokuko', 'setup', '--offline', '--json']), /unavailable for offline setup/);
});

test('embedding plan counts persisted entries without changing database or WAL files', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-unified-existing-'));
  const file = path.join(root, 'kiokuko.sqlite3');
  const database = openConnection(file);
  try {
    migrateDatabase(database);
    recordEntry(database, { workspace: 'project:unified', kind: 'fact', title: 'Stored entry', body: 'Plan existing entries without activating embeddings.', createdBy: 'test' });
    const paths = [file, `${file}-wal`, `${file}-shm`];
    const before = await Promise.all(paths.map(p => readFile(p)));
    const plan = await planEmbeddingSetup(file);
    assert.equal(plan.embeddings.eligible, 1);
    assert.equal(plan.embeddings.remaining, 1);
    assert.equal(plan.semanticEnabled, false);
    assert.deepEqual(await Promise.all(paths.map(p => readFile(p))), before);
  } finally {
    database.close();
  }
});
