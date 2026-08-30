import assert from 'node:assert/strict';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry } from '../../src/memory/entries.js';
import { rankedEntryHits, searchEntries } from '../../src/memory/retrieval.js';

test('the unified FTS lane retrieves a Japanese-only entry from a Japanese word query', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const entry = recordEntry(database, {
      workspace: 'project:cjk-retrieval',
      kind: 'decision',
      status: 'verified',
      title: '履歴保全方針',
      body: '過去のマイグレーションファイルは直接編集せず、新しいファイルで前方移行する。',
      tags: ['履歴保全'],
    });

    const directFtsRows = database.prepare(`
      SELECT rowid FROM entries_fts WHERE entries_fts MATCH ?
    `).all('"マイグレーション"');
    assert.equal(directFtsRows.length, 1);

    const hits = rankedEntryHits(database, {
      workspace: 'project:cjk-retrieval',
      query: 'マイグレーション',
      limit: 5,
    });
    const hit = hits.hits.find((candidate) => candidate.entryId === entry.id);
    assert.ok(hit);
    assert.ok(hit.reasons.includes('substring_match'));
    assert.ok(hit.reasons.includes('cjk_window_match'));
  } finally {
    database.close();
  }
});

test('a shifted long Japanese task still retrieves the stored forward-only migration policy', () => {
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    const entry = recordEntry(database, {
      workspace: 'project:cjk-replay',
      kind: 'decision',
      status: 'verified',
      title: '履歴保全',
      body: '過去のマイグレーションは変更しない。常に新しいマイグレーションを追加して前方移行する。',
    });

    const result = searchEntries(database, {
      workspace: 'project:cjk-replay',
      query: '開発環境に既存データがなく、過去のマイグレーションファイルを直接編集することを明示的に承認しているため、テーブルにカラムを追加する。',
    });
    assert.ok(result.items.some((item) => item.id === entry.id));
  } finally {
    database.close();
  }
});
