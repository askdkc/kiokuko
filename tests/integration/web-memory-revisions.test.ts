import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { recordEntry } from '../../src/memory/entries.js';
import { startWebServer } from '../../src/web/server.js';

async function session(baseUrl: string): Promise<string> {
  const response = await fetch(baseUrl);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie?.startsWith('kiokuko_ui_session=')) throw new Error('UI session cookie was not issued');
  return cookie;
}

async function webFetch(baseUrl: string, pathname: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('cookie', await session(baseUrl));
  return fetch(`${baseUrl}${pathname}`, { ...options, headers });
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-web-memory-revisions-'));
  const databasePath = path.join(directory, 'kiokuko.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  const entry = recordEntry(database, {
    workspace: 'project:web-revisions',
    kind: 'reference',
    title: 'PostgreSQL',
    body: 'PostgreSQL PGroonga',
    tags: ['postgresql'],
  });
  database.close();
  return { databasePath, entry };
}

test('Web memory uses only the current immutable revision for editing, filters, tags, and search', async () => {
  const data = await fixture();
  const web = await startWebServer({ databasePath: data.databasePath, host: '127.0.0.1', port: 0, httpOptions: { runtimeDirectory: path.join(path.dirname(data.databasePath), 'runtime') } });
  try {
    const workspaceResponse = await webFetch(web.url, '/api/workspaces');
    assert.equal(workspaceResponse.status, 200);
    assert.deepEqual((await workspaceResponse.json() as { workspaces: Array<{ workspace: string }> }).workspaces.map((item) => item.workspace), ['project:web-revisions']);

    const detail = await webFetch(web.url, `/api/entries/${data.entry.id}?workspace=project%3Aweb-revisions`).then((response) => response.json()) as { entry: { revision: number; title: string } };
    assert.deepEqual({ revision: detail.entry.revision, title: detail.entry.title }, { revision: 1, title: 'PostgreSQL' });

    const firstSearch = await webFetch(web.url, '/api/entries?workspace=project%3Aweb-revisions&q=PGroonga').then((response) => response.json()) as { entries: Array<{ id: string }> };
    assert.deepEqual(firstSearch.entries.map((item) => item.id), [data.entry.id]);

    const update = await webFetch(web.url, `/api/entries/${data.entry.id}?workspace=project%3Aweb-revisions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: 1,
        kind: 'lesson',
        title: 'SQLite',
        body: 'SQLite FTS5 trigram',
        summary: null,
        scope: {},
        provenance: {},
        tags: ['sqlite'],
      }),
    });
    assert.equal(update.status, 200);
    const updated = await update.json() as { entry: { revision: number; kind: string; title: string; body: string; tags: string[] } };
    assert.deepEqual(updated.entry, {
      ...updated.entry,
      revision: 2,
      kind: 'lesson',
      title: 'SQLite',
      body: 'SQLite FTS5 trigram',
      tags: ['sqlite'],
    });

    const editedDetail = await webFetch(web.url, `/api/entries/${data.entry.id}?workspace=project%3Aweb-revisions`).then((response) => response.json()) as { entry: { revision: number; body: string } };
    assert.deepEqual({ revision: editedDetail.entry.revision, body: editedDetail.entry.body }, { revision: 2, body: 'SQLite FTS5 trigram' });

    for (const [query, expected] of [['PGroonga', 0], ['trigram', 1]] as const) {
      const result = await webFetch(web.url, `/api/entries?workspace=project%3Aweb-revisions&q=${query}`).then((response) => response.json()) as { entries: unknown[] };
      assert.equal(result.entries.length, expected, `search query ${query}`);
    }
    for (const [parameter, expected] of [['kind=reference', 0], ['kind=lesson', 1], ['tag=postgresql', 0], ['tag=sqlite', 1]] as const) {
      const result = await webFetch(web.url, `/api/entries?workspace=project%3Aweb-revisions&${parameter}`).then((response) => response.json()) as { entries: unknown[] };
      assert.equal(result.entries.length, expected, `filter ${parameter}`);
    }
    const tags = await webFetch(web.url, '/api/tags?workspace=project%3Aweb-revisions').then((response) => response.json()) as { tags: Array<{ tag: string; count: number }> };
    assert.deepEqual(tags.tags, [{ tag: 'sqlite', count: 1 }]);

    const stale = await webFetch(web.url, `/api/entries/${data.entry.id}?workspace=project%3Aweb-revisions`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 1, kind: 'lesson', title: 'stale', body: 'stale', tags: [] }),
    });
    assert.equal(stale.status, 409);
  } finally {
    await web.close();
  }

  const database = openConnection(data.databasePath);
  try {
    assert.deepEqual(database.prepare('SELECT revision FROM entry_revisions WHERE entry_id = ? ORDER BY revision').all<{ revision: number }>(data.entry.id).map((row) => row.revision), [1, 2]);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(database.prepare('PRAGMA integrity_check').get<{ integrity_check: string }>()?.integrity_check, 'ok');
  } finally {
    database.close();
  }
});
