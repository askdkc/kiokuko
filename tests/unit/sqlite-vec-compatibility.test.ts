import assert from 'node:assert/strict';
import test from 'node:test';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { detectSqliteVecCapability } from '../../src/db/capabilities.js';

function probe(version: string, distance?: number): SqliteDatabase {
  return {
    prepare(sql: string) {
      return { get(...vectors: Uint8Array[]) {
        if (sql.includes('vec_version()')) return { version };
        if (sql.includes('vec_distance_cosine(') && distance !== undefined) {
          return { distance: vectors[0] === vectors[1] ? 0 : distance };
        }
        throw new Error('required vector API unavailable');
      } };
    },
  } as unknown as SqliteDatabase;
}

test('a newer sqlite-vec version is usable when the required vector API works', () => {
  assert.deepEqual(detectSqliteVecCapability(probe('v0.1.10', 1)), {
    id: 'sqlite-vec', available: true, version: 'v0.1.10',
  });
});

test('matching or newer version text cannot substitute for the required vector API', () => {
  for (const version of ['v0.1.9', 'v0.1.10']) {
    assert.deepEqual(detectSqliteVecCapability(probe(version)), {
      id: 'sqlite-vec', available: false, version: null,
    });
  }
});
