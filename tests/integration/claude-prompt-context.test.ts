import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { buildClaudePromptHookOutput } from '../../src/mcp/claude-prompt-context.js';
import { checkpointScopedMemory } from '../../src/memory/scoped-memory.js';
import type { SqliteDatabase } from '../../src/db/adapter.js';

async function repository(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `kiokuko-claude-hook-${prefix}-`));
  execFileSync('git', ['init', '-q', root]);
  return root;
}

function seedStoredMemoryFixture(database: SqliteDatabase, input: { entryId: string; title: string; body: string }): void {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO entries (
      id, workspace, status, trust_level, confidence, current_revision,
      superseded_by, created_by, created_at, updated_at, verified_at
    ) VALUES (?, 'global', 'candidate', 'untrusted', 0.5, 1, NULL, 'test-fixture', ?, ?, NULL)
  `).run(input.entryId, now, now);
  database.prepare(`
    INSERT INTO entry_revisions (
      entry_id, workspace, revision, kind, title, body, summary,
      scope_json, provenance_json, content_hash, created_by, created_at
    ) VALUES (?, 'global', 1, 'preference', ?, ?, NULL, '{}', '{}', ?, 'test-fixture', ?)
  `).run(input.entryId, input.title, input.body, `fixture-hash-${input.entryId}`, now);
  const row = database.prepare('SELECT rowid FROM entries WHERE id = ?').get<{ rowid: number }>(input.entryId);
  assert.ok(row);
  database.prepare('INSERT INTO entries_fts(rowid, title, body, summary, tags_text) VALUES (?, ?, ?, ?, ?)').run(row.rowid, input.title, input.body, '', '');
}

test('builds bounded untrusted Claude pre-recall context without persisting hook input', async () => {
  const root = await repository('context');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-claude-hook-db-'));
  const databasePath = path.join(data, 'kiokuko.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  const prompt = 'claude hook durable beacon; input-only-sentinel';
  const sessionId = 'session-id-must-not-be-stored';
  try {
    await checkpointScopedMemory(database, {
      cwd: root,
      memories: [
        { kind: 'lesson', title: 'Claude hook durable beacon', body: `Verify the durable beacon before changing /tmp/secret-path-${'x'.repeat(80)}.` },
        { kind: 'decision', title: 'Claude hook durable beacon second', body: 'Keep the hook context small.' },
        { kind: 'fact', title: 'Claude hook durable beacon third', body: 'The hook is only a pre-recall layer.' },
        { kind: 'reference', title: 'Claude hook durable beacon fourth', body: 'This fourth result must be omitted by the hook limit.' },
        { kind: 'lesson', title: 'Unrelated memory', body: 'This should not be selected by the query.' },
      ],
    });

    const first = await buildClaudePromptHookOutput(database, { prompt, cwd: root, sessionId });
    const second = await buildClaudePromptHookOutput(database, { prompt, cwd: root, sessionId });
    assert.deepEqual(second, first);
    const additionalContext = String((first.hookSpecificOutput as { additionalContext: string }).additionalContext);
    assert.match(additionalContext, /untrusted historical memory/u);
    assert.match(additionalContext, /Claude hook durable beacon/u);
    assert.doesNotMatch(additionalContext, /secret-path|session-id-must-not-be-stored/u);
    assert.equal((additionalContext.match(/^\d+\. /gmu) ?? []).length <= 3, true);
    assert.ok(additionalContext.length <= 3500);

    const storedPrompt = database.prepare('SELECT COUNT(*) AS count FROM entries AS e JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision WHERE r.title LIKE ? OR r.body LIKE ?').get<{ count: number }>(`%${prompt}%`, `%${prompt}%`);
    const storedSession = database.prepare('SELECT COUNT(*) AS count FROM entries AS e JOIN entry_revisions AS r ON r.entry_id = e.id AND r.revision = e.current_revision WHERE r.title LIKE ? OR r.body LIKE ?').get<{ count: number }>(`%${sessionId}%`, `%${sessionId}%`);
    assert.equal(storedPrompt?.count, 0);
    assert.equal(storedSession?.count, 0);
  } finally {
    database.close();
  }
});

test('returns an empty object for no matches and rejects oversized prompts', async () => {
  const root = await repository('empty');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-claude-hook-empty-db-'));
  const databasePath = path.join(data, 'kiokuko.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const before = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM repositories) AS repositories,
        (SELECT COUNT(*) FROM repository_locations) AS locations,
        (SELECT COUNT(*) FROM repository_fingerprints) AS fingerprints
    `).get<{ repositories: number; locations: number; fingerprints: number }>();
    assert.deepEqual(await buildClaudePromptHookOutput(database, { prompt: 'no matching memory', cwd: root }), {});
    const after = database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM repositories) AS repositories,
        (SELECT COUNT(*) FROM repository_locations) AS locations,
        (SELECT COUNT(*) FROM repository_fingerprints) AS fingerprints
    `).get<{ repositories: number; locations: number; fingerprints: number }>();
    assert.deepEqual(after, before);
    await checkpointScopedMemory(database, {
      cwd: root,
      memories: [{ scope: 'global', kind: 'preference', title: 'Global Claude hook memory', body: 'Use the global pre-recall preference.' }],
    });
    const global = await buildClaudePromptHookOutput(database, { prompt: 'global Claude hook memory', cwd: root });
    assert.match(String((global.hookSpecificOutput as { additionalContext: string }).additionalContext), /Global Claude hook memory/u);
    await assert.rejects(
      buildClaudePromptHookOutput(database, { prompt: 'x'.repeat(64 * 1024 + 1), cwd: root }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
    );
  } finally {
    database.close();
  }
});

test('redacts embedded Unix, file URI, UNC, and Windows absolute paths', async () => {
  const root = await repository('paths');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-claude-hook-path-db-'));
  const databasePath = path.join(data, 'kiokuko.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  const rawPaths = [
    '/Users/alice/private/project/secrets.txt',
    'path=/Users/alice/private/project/secrets.txt',
    'path:/Users/alice/private/project/secrets.txt',
    'file:///Users/alice/private/project/secrets.txt',
    '\\\\server\\share\\private project\\secrets.txt',
    'C:\\Users\\alice\\private project\\secrets.txt',
    '<file:///Users/alice/private/secrets.txt>',
    '>/Users/alice/private/secrets.txt',
    'command >/Users/alice/private/secrets.txt',
    'command 2> /Users/alice/private/secrets.txt',
  ];
  try {
    await checkpointScopedMemory(database, {
      cwd: root,
      memories: [{
        scope: 'global',
        kind: 'preference',
        title: 'Embedded absolute path sentinel',
        body: `Review embedded absolute path sentinel before retrying.\nEdit ./src/alpha.ts and ../shared/beta.ts after reading docs/guide.md.\n${rawPaths.join('\n')}\nhttps://example.com/docs/hooks`,
      }],
    });
    const result = await buildClaudePromptHookOutput(database, {
      prompt: 'embedded absolute path sentinel',
      cwd: root,
    });
    const additionalContext = String((result.hookSpecificOutput as { additionalContext: string }).additionalContext);
    for (const rawPath of rawPaths) assert.doesNotMatch(additionalContext, new RegExp(rawPath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')));
    assert.match(additionalContext, /https:\/\/example\.com\/docs\/hooks/u);
    assert.match(additionalContext, /\[REDACTED:absolute_path\]/u);
    assert.match(additionalContext, /Edit \.\/src\/alpha\.ts and \.\.\/shared\/beta\.ts after reading docs\/guide\.md\./u);
    assert.doesNotMatch(additionalContext, /\.\[REDACTED:absolute_path\]/u);
  } finally {
    database.close();
  }
});

test('redacts secret-like stored memory before emitting Claude hook context', async () => {
  const root = await repository('secrets');
  const data = await mkdtemp(path.join(tmpdir(), 'kiokuko-claude-hook-secret-db-'));
  const databasePath = path.join(data, 'kiokuko.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  const rawSecret = `Authorization: Bearer ${'a'.repeat(16)}`;
  try {
    seedStoredMemoryFixture(database, {
      entryId: 'claude-hook-secret-fixture',
      title: 'Stored secret-like memory sentinel',
      body: `Never emit this stored value: ${rawSecret}`,
    });
    const result = await buildClaudePromptHookOutput(database, {
      prompt: 'stored secret-like memory sentinel',
      cwd: root,
    });
    const additionalContext = String((result.hookSpecificOutput as { additionalContext: string }).additionalContext);
    assert.doesNotMatch(additionalContext, /Authorization: Bearer|a{16}/u);
    assert.match(additionalContext, /\[REDACTED:authorization_header\]/u);
  } finally {
    database.close();
  }
});
