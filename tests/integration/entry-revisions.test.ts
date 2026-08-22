import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry, readEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { findEntryRevision, readEntryRevision } from '../../src/memory/revisions.js';
import { KiokukoError } from '../../src/errors.js';

const migrationsDirectory = path.resolve(import.meta.dirname, '../../migrations');

async function database() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-entry-revisions-'));
  const db = openConnection(path.join(directory, 'data.sqlite3'));
  migrateDatabase(db, migrationsDirectory);
  return db;
}

function code(error: unknown): string | undefined {
  return error instanceof KiokukoError ? error.code : undefined;
}

test('entry content and tags are immutable per revision', async () => {
  const db = await database();
  try {
    assert.deepEqual(db.prepare('PRAGMA table_info(entries)').all<{ name: string }>().map((column) => column.name), [
      'id', 'workspace', 'status', 'trust_level', 'confidence', 'current_revision', 'superseded_by',
      'created_by', 'created_at', 'updated_at', 'verified_at',
    ]);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tags'").get(), undefined);
    const first = recordEntry(db, {
      workspace: 'project:revisions',
      kind: 'reference',
      title: 'PostgreSQL',
      body: 'PGroonga',
      summary: 'revision one',
      scope: { applicability: { databases: ['PostgreSQL'] } },
      provenance: { type: 'test', reference: 'revision-1' },
      tags: ['postgresql', 'old'],
      createdBy: 'test',
    });
    assert.equal(first.revision, 1);
    assert.equal(db.prepare('SELECT current_revision FROM entries WHERE id = ?').get<{ current_revision: number }>(first.id)?.current_revision, 1);
    assert.deepEqual(readEntryRevision(db, { entryId: first.id, workspace: first.workspace, revision: 1 }), {
      entryId: first.id,
      workspace: first.workspace,
      revision: 1,
      kind: 'reference',
      title: 'PostgreSQL',
      body: 'PGroonga',
      summary: 'revision one',
      scope: { applicability: { databases: ['PostgreSQL'] } },
      provenance: { reference: 'revision-1', type: 'test' },
      tags: ['old', 'postgresql'],
      contentHash: first.contentHash,
      createdBy: 'test',
      createdAt: first.createdAt,
    });

    const second = updateCandidateEntry(db, {
      workspace: first.workspace,
      entryId: first.id,
      expectedRevision: 1,
      kind: 'lesson',
      title: 'SQLite',
      body: 'FTS5 trigram',
      summary: 'revision two',
      scope: { applicability: { databases: ['SQLite'] } },
      provenance: { type: 'test', reference: 'revision-2' },
      tags: ['new', 'sqlite'],
    });
    assert.equal(second.revision, 2);
    assert.deepEqual(readEntryRevision(db, { entryId: first.id, workspace: first.workspace, revision: 1 }).tags, ['old', 'postgresql']);
    assert.deepEqual(readEntryRevision(db, { entryId: first.id, workspace: first.workspace, revision: 2 }), {
      entryId: first.id,
      workspace: first.workspace,
      revision: 2,
      kind: 'lesson',
      title: 'SQLite',
      body: 'FTS5 trigram',
      summary: 'revision two',
      scope: { applicability: { databases: ['SQLite'] } },
      provenance: { reference: 'revision-2', type: 'test' },
      tags: ['new', 'sqlite'],
      contentHash: second.contentHash,
      createdBy: 'kiokuko-web',
      createdAt: second.updatedAt,
    });
    assert.equal(readEntry(db, { workspace: first.workspace, entryId: first.id }).revision, 2);
    assert.equal(findEntryRevision(db, { entryId: first.id, workspace: first.workspace, revision: 99 }), undefined);

    assert.throws(() => db.prepare('UPDATE entry_revisions SET title = ? WHERE entry_id = ? AND revision = 1').run('mutated', first.id));
    assert.deepEqual(db.prepare('SELECT revision FROM entry_revisions WHERE entry_id = ? ORDER BY revision').all<{ revision: number }>(first.id).map((row) => row.revision), [1, 2]);
  } finally {
    db.close();
  }
});

test('stale, verified, superseded, secret, and duplicate edits do not append revisions', async () => {
  const db = await database();
  try {
    const first = recordEntry(db, { workspace: 'project:guards', kind: 'lesson', title: 'one', body: 'one' });
    const other = recordEntry(db, { workspace: 'project:guards', kind: 'lesson', title: 'edited', body: 'two' });
    const edit = (body: string, expectedRevision = 1) => updateCandidateEntry(db, {
      workspace: first.workspace,
      entryId: first.id,
      expectedRevision,
      kind: 'lesson',
      title: 'edited',
      body,
    });

    assert.throws(() => edit('stale', 2), (error) => code(error) === 'CONFLICT');
    assert.throws(() => edit(other.body), (error) => code(error) === 'CONFLICT');
    assert.throws(() => edit('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789'), (error) => code(error) === 'SECURITY_REJECTION');
    assert.deepEqual(db.prepare('SELECT revision FROM entry_revisions WHERE entry_id = ? ORDER BY revision').all<{ revision: number }>(first.id).map((row) => row.revision), [1]);

    const verified = recordEntry(db, { workspace: first.workspace, kind: 'fact', status: 'verified', title: 'verified', body: 'fixed' });
    assert.throws(() => updateCandidateEntry(db, { workspace: first.workspace, entryId: verified.id, expectedRevision: 1, kind: 'lesson', title: 'x', body: 'x' }), (error) => code(error) === 'CONFLICT');
    const superseded = recordEntry(db, { workspace: first.workspace, kind: 'fact', title: 'old', body: 'old' });
    db.prepare("UPDATE entries SET status = 'superseded', superseded_by = ? WHERE id = ?").run(other.id, superseded.id);
    assert.throws(() => updateCandidateEntry(db, { workspace: first.workspace, entryId: superseded.id, expectedRevision: 1, kind: 'lesson', title: 'x', body: 'x' }), (error) => code(error) === 'CONFLICT');
  } finally {
    db.close();
  }
});
