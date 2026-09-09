import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runDoctor } from '../../src/commands/doctor.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry } from '../../src/memory/entries.js';
import { hybridSearchProjectionStatus, rebuildHybridSearch } from '../../src/memory/rebuild-search.js';

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-cjk-baseline-'));
  const databasePath = path.join(directory, 'data.sqlite3');
  const database = openConnection(databasePath);
  migrateDatabase(database);
  const entry = recordEntry(database, { workspace: 'project:cjk', kind: 'decision', title: '履歴保全方針', body: 'マイグレーションの整合性を検証する。', tags: ['履歴保全'] });
  return { databasePath, database, entry, directory };
}

test('baseline word and trigram projections retain Japanese text and exact current revisions', async () => {
  const { database, entry } = await fixture();
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM entries_trigram WHERE entries_trigram MATCH ?").get('"マイグレーション"')?.count, 1);
    assert.equal(database.prepare('SELECT body FROM entry_search_documents WHERE entry_id = ?').get(entry.id)?.body, entry.body);
    assert.doesNotThrow(() => hybridSearchProjectionStatus(database));
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { database.close(); }
});

test('doctor rejects an empty external FTS index and rebuild restores MATCH', async () => {
  const { database, databasePath, directory } = await fixture();
  try {
    database.exec("INSERT INTO entries_trigram(entries_trigram) VALUES ('delete-all')");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM entries_trigram WHERE entries_trigram MATCH ?").get('"マイグレーション"')?.count, 0);
    assert.equal((await runDoctor({ databasePath, runtimeDescriptorPath: path.join(directory, 'server.json') })).checks.hybridSearch.ok, false);
    rebuildHybridSearch(database);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM entries_trigram WHERE entries_trigram MATCH ?").get('"マイグレーション"')?.count, 1);
    assert.doesNotThrow(() => hybridSearchProjectionStatus(database));
  } finally { database.close(); }
});
