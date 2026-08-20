import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry } from '../../src/memory/entries.js';
import { promoteEntry, supersedeEntry } from '../../src/memory/lifecycle.js';
import { searchEntries } from '../../src/memory/retrieval.js';

async function database() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-life-'));
  const db = openConnection(path.join(directory, 'db.sqlite3'));
  migrateDatabase(db);
  return db;
}

test('enforces candidate promotion and stale revision conflicts', async () => {
  const db = await database();
  try {
    const entry = recordEntry(db, { workspace: 'project:life', kind: 'decision', title: 'Candidate', body: 'body' });
    const promoted = promoteEntry(db, { workspace: 'project:life', entryId: entry.id, expectedRevision: 1 });
    assert.equal(promoted.status, 'verified');
    assert.equal(promoted.revision, 2);
    assert.throws(() => promoteEntry(db, { workspace: 'project:life', entryId: entry.id, expectedRevision: 1 }), /stale|candidate/i);
  } finally {
    db.close();
  }
});

test('supersedes an entry and excludes it from normal search', async () => {
  const db = await database();
  try {
    const oldEntry = recordEntry(db, { workspace: 'project:life2', kind: 'lesson', title: 'Old', body: 'memory text' });
    const replacement = recordEntry(db, { workspace: 'project:life2', kind: 'lesson', title: 'New', body: 'current memory text' });
    const result = supersedeEntry(db, { workspace: 'project:life2', oldEntryId: oldEntry.id, replacementEntryId: replacement.id, expectedRevision: 1 });
    assert.equal(result.status, 'superseded');
    const found = searchEntries(db, { workspace: 'project:life2', query: 'memory' });
    assert.deepEqual(found.items.map((item) => item.id), [replacement.id]);
  } finally {
    db.close();
  }
});
