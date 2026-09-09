import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportWorkspace } from '../../src/commands/export.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { KiokukoError } from '../../src/errors.js';
import { readEntry, recordEntry, type EntryRecord } from '../../src/memory/entries.js';
import { readEntryRevision } from '../../src/memory/revisions.js';
import {
  canonicalContentHash,
  canonicalJson,
  type JsonObject
} from '../../src/serialization/validate.js';
const TAGS = ['漢', 'z', 'ä', '😀', 'a', 'å'];
const LEGACY_TAG_ORDER = ['漢', '😀', 'z', 'å', 'ä', 'a'];
const REVISION_TRIGGER = `CREATE TRIGGER entry_revisions_immutable_update
BEFORE UPDATE ON entry_revisions
BEGIN
    SELECT RAISE(ABORT, 'entry_revisions are immutable');
END`;

function replaceRevisionWithReleasedPreimage(
  db: ReturnType<typeof openConnection>,
  entry: EntryRecord,
  content: EntryRecord,
  persistedScope: JsonObject,
  hashTags: readonly string[],
  persistedTags: readonly string[] = hashTags,
): string {
  const contentHash = canonicalContentHash({
    kind: content.kind,
    title: content.title,
    body: content.body,
    summary: content.summary,
    scope: persistedScope,
    provenance: content.provenance,
    tags: [...hashTags],
  });
  db.exec('DROP TRIGGER entry_revisions_immutable_update');
  db.prepare(`
    UPDATE entry_revisions
       SET kind = ?, title = ?, body = ?, summary = ?, scope_json = ?,
           provenance_json = ?, content_hash = ?
     WHERE entry_id = ? AND revision = ?
  `).run(
    content.kind,
    content.title,
    content.body,
    content.summary,
    canonicalJson(persistedScope),
    canonicalJson(content.provenance),
    contentHash,
    entry.id,
    entry.revision,
  );
  db.prepare('DELETE FROM entry_revision_tags WHERE entry_id = ? AND revision = ?')
    .run(entry.id, entry.revision);
  for (const tag of persistedTags) {
    db.prepare('INSERT INTO entry_revision_tags (entry_id, revision, tag) VALUES (?, ?, ?)')
      .run(entry.id, entry.revision, tag);
  }
  db.exec(REVISION_TRIGGER);
  return contentHash;
}

test('post-migration runtime rejects legacy hashes instead of entering a compatibility path', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-runtime-revision-clean-break-'));
  const db = openConnection(path.join(directory, 'kiokuko.sqlite3'));
  try {
    migrateDatabase(db);
    const entry = recordEntry(db, {
      workspace: 'project:runtime-revision-clean-break',
      kind: 'lesson',
      title: 'No runtime fallback',
      body: 'A legacy hash introduced after migration is corruption.',
      tags: TAGS,
    });
    replaceRevisionWithReleasedPreimage(db, entry, entry, entry.scope, LEGACY_TAG_ORDER);

    for (const operation of [
      () => readEntry(db, { workspace: entry.workspace, entryId: entry.id }),
      () => readEntryRevision(db, { workspace: entry.workspace, entryId: entry.id, revision: entry.revision }),
      () => exportWorkspace(db, { workspace: entry.workspace }),
    ]) {
      assert.throws(
        operation,
        (error: unknown) => error instanceof KiokukoError && error.code === 'INTEGRITY_ERROR',
      );
    }
  } finally {
    db.close();
  }
});
