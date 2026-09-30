import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { searchEntries } from '../../src/memory/retrieval.js';

async function temporaryDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const database = openConnection(path.join(directory, 'kiokuko.sqlite3'));
  migrateDatabase(database);
  return database;
}

test('recorded restrict uses revision timestamps and half-open time bounds', async () => {
  const database = await temporaryDatabase('temporal-search');
  try {
    const workspace = 'project:temporal-search';
    const before = recordEntry(database, { workspace, kind: 'fact', title: 'Deploy before window', body: 'deploy marker' },
      { now: '2026-04-30T23:59:59.999Z', idFactory: () => 'before' });
    const start = recordEntry(database, { workspace, kind: 'fact', title: 'Deploy at start', body: 'deploy marker' },
      { now: '2026-05-01T00:00:00.000Z', idFactory: () => 'at-start' });
    const end = recordEntry(database, { workspace, kind: 'fact', title: 'Deploy at end', body: 'deploy marker' },
      { now: '2026-05-02T00:00:00.000Z', idFactory: () => 'at-end' });

    const result = searchEntries(database, {
      workspace, query: 'deploy marker', relatedMode: 'off',
      temporal: {
        basis: 'recorded', mode: 'restrict', start: '2026-05-01T00:00:00.000Z',
        end: '2026-05-02T00:00:00.000Z', anchorTime: '2026-05-03T00:00:00.000Z', timezone: 'UTC',
      },
    });
    assert.deepEqual(result.items.map((entry) => entry.id), [start.id]);
    assert.equal(result.items.some((entry) => entry.id === before.id || entry.id === end.id), false);
  } finally {
    database.close();
  }
});

test('occurred restrict requires a current same-workspace revision source', async () => {
  const database = await temporaryDatabase('occurred-search');
  try {
    const workspace = 'project:occurred-search';
    const source = recordEntry(database, { workspace, kind: 'fact', title: 'Incident source', body: 'Primary incident record', status: 'candidate' },
      { now: '2026-01-12T00:00:00.000Z', idFactory: () => 'incident-source' });
    const target = recordEntry(database, {
      workspace, kind: 'lesson', title: 'Incident lesson', body: 'incident lesson marker',
      provenance: { type: 'entry_revision', reference: 'source-backed event time', temporal: { occurredAt: {
        instant: '2026-01-10T12:00:00Z',
        source: { workspace, entryId: source.id, revision: source.revision, contentHash: source.contentHash },
      } } },
    }, { now: '2026-02-01T00:00:00.000Z', idFactory: () => 'incident-lesson' });
    const condition = {
      basis: 'occurred' as const, mode: 'restrict' as const,
      start: '2026-01-10T00:00:00Z', end: '2026-01-11T00:00:00Z',
      anchorTime: '2026-02-02T00:00:00Z', timezone: 'UTC',
    };
    assert.deepEqual(searchEntries(database, { workspace, query: 'incident lesson', temporal: condition }).items.map((entry) => entry.id), [target.id]);

    updateCandidateEntry(database, {
      workspace, entryId: source.id, expectedRevision: source.revision,
      kind: 'fact', title: 'Updated incident source', body: 'Updated primary incident record',
    });
    assert.deepEqual(searchEntries(database, { workspace, query: 'incident lesson', temporal: condition }).items, []);
  } finally {
    database.close();
  }
});

test('related mode is opt-in, bounded to one workspace hop, and labels links as candidates', async () => {
  const database = await temporaryDatabase('related-search');
  try {
    const workspace = 'project:related-search';
    const seed = recordEntry(database, { workspace, kind: 'fact', title: 'Gateway timeout', body: 'gateway timeout seed' },
      { now: '2026-01-01T00:00:00.000Z', idFactory: () => 'gateway-seed' });
    const linked = recordEntry(database, { workspace, kind: 'lesson', title: 'Retry boundary', body: 'backoff edge case' },
      { now: '2026-01-02T00:00:00.000Z', idFactory: () => 'retry-boundary' });
    const foreign = recordEntry(database, { workspace: 'project:other', kind: 'lesson', title: 'Foreign retry', body: 'backoff edge case' },
      { now: '2026-01-02T00:00:00.000Z', idFactory: () => 'foreign-retry' });
    database.prepare('INSERT INTO entry_links(from_entry_id, to_entry_id, relation, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(seed.id, linked.id, 'related_to', '2026-01-03T00:00:00.000Z', 'test');
    database.prepare('INSERT INTO entry_links(from_entry_id, to_entry_id, relation, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(seed.id, foreign.id, 'related_to', '2026-01-03T00:00:00.000Z', 'test');

    const baseline = searchEntries(database, { workspace, query: 'gateway timeout', relatedMode: 'off' });
    const expanded = searchEntries(database, { workspace, query: 'gateway timeout', relatedMode: 'active' });
    assert.equal(baseline.items.some((entry) => entry.id === linked.id), false);
    assert.equal(expanded.items.some((entry) => entry.id === linked.id), true);
    assert.equal(expanded.items.some((entry) => entry.id === foreign.id), false);
    assert.ok(expanded.items.some((entry) => entry.id === seed.id));
  } finally {
    database.close();
  }
});
