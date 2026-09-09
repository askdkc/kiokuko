import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
}

const embeddingTables = [
  'embedding_profiles',
  'embedding_runtime',
  'entry_embeddings',
  'embedding_jobs',
  'query_embeddings',
] as const;

test('baseline installs the derived embedding schema without provider I/O', async () => {
  const directory = await temporaryDirectory('embedding-migration');
  const database = openConnection(path.join(directory, 'data.sqlite3'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('provider I/O is forbidden during migration');
  }) as typeof fetch;
  try {
    const result = migrateDatabase(database);
    assert.equal(result.currentVersion, 1);
    assert.deepEqual(result.applied, [1]);
    for (const table of embeddingTables) {
      assert.equal(
        database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.present,
        1,
        `missing ${table}`,
      );
    }
    const runtime = database.prepare('SELECT singleton, active_profile_id, generation, activated_at FROM embedding_runtime').get();
    assert.deepEqual(runtime === undefined ? undefined : { ...runtime }, {
      singleton: 1,
      active_profile_id: null,
      generation: 1,
      activated_at: null,
    });
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual({ ...(database.prepare('SELECT mode, provider_kind, setup_state FROM embedding_settings').get() as object) }, {
      mode: 'off',
      provider_kind: null,
      setup_state: 'disabled',
    });
    assert.deepEqual(migrateDatabase(database).applied, []);
  } finally {
    globalThis.fetch = originalFetch;
    database.close();
  }
});
