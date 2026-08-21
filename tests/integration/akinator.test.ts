import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { answerAkinator, getAkinatorContext, startAkinator } from '../../src/akinator/orchestrator.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { recordEntry } from '../../src/memory/entries.js';

async function temporaryDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const database = openConnection(path.join(directory, 'kiokuko.sqlite3'));
  migrateDatabase(database);
  return database;
}

function sourceFetch(): typeof fetch {
  const skill = `---\nname: tdd\ndescription: Use when implementing any feature or bugfix.\n---\n\n# Test-driven development\n\nWrite a failing test before implementation and verify the smallest green change.\n`;
  const responses = new Map<string, unknown>([
    ['https://api.github.com/repos/mattpocock/skills/commits/main', { sha: 'mattpocock-commit-1' }],
    ['https://api.github.com/repos/mattpocock/skills/git/trees/mattpocock-commit-1?recursive=1', {
      truncated: false,
      tree: [{ path: 'skills/engineering/tdd/SKILL.md', type: 'blob' }],
    }],
    ['https://raw.githubusercontent.com/mattpocock/skills/mattpocock-commit-1/skills/engineering/tdd/SKILL.md', skill],
  ]);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const value = responses.get(url);
    if (value === undefined) return new Response('not found', { status: 404 });
    if (typeof value === 'string') return new Response(value, { status: 200, headers: { 'content-type': 'text/markdown' } });
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

test('asks only missing high-value fields, then returns local knowledge and skill hints', async () => {
  const database = await temporaryDatabase('akinator-local');
  try {
    const local = recordEntry(database, {
      workspace: 'project:akinator',
      kind: 'lesson',
      title: 'Builder TDD convention',
      body: 'Implement changes with a failing test first.',
      tags: ['bot:builder', 'skill:test-driven-development'],
    });

    const started = await startAkinator(database, {
      workspace: 'project:akinator',
      task: '実装してテストを追加する',
      now: '2026-08-20T00:00:00.000Z',
    });
    assert.equal(started.status, 'needs_answer');
    assert.equal(started.question?.id, 'target');
    assert.ok(started.recommendedTags.includes('bot:builder'));

    const withTarget = await answerAkinator(database, {
      workspace: 'project:akinator',
      sessionId: started.session.id,
      questionId: 'target',
      value: 'src/feature.ts',
      now: '2026-08-20T00:01:00.000Z',
    });
    assert.equal(withTarget.question?.id, 'expected');

    const ready = await answerAkinator(database, {
      workspace: 'project:akinator',
      sessionId: started.session.id,
      questionId: 'expected',
      value: 'テストが通り、実装が完成すること',
      now: '2026-08-20T00:02:00.000Z',
    });
    assert.equal(ready.status, 'ready');

    const context = await getAkinatorContext(database, {
      workspace: 'project:akinator',
      sessionId: started.session.id,
      fetchImpl: sourceFetch(),
      now: '2026-08-20T00:03:00.000Z',
    });
    assert.equal(context.status, 'ready');
    assert.equal(context.externalSync.attempted, false);
    assert.ok(context.entries.some((entry) => entry.id === local.id));
    assert.ok(context.instructions.some((instruction: string) => instruction.includes('untrusted')));
  } finally {
    database.close();
  }
});

test('rejects an answer for anything except the current question without mutating the session', async () => {
  const database = await temporaryDatabase('akinator-current-question');
  try {
    const started = await startAkinator(database, {
      workspace: 'project:current-question',
      task: '実装する',
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'akinator-current-question-fixed',
    });
    assert.equal(started.question?.id, 'target');

    await assert.rejects(answerAkinator(database, {
      workspace: 'project:current-question',
      sessionId: started.session.id,
      questionId: 'expected',
      value: 'tests pass',
      now: '2026-08-20T00:01:00.000Z',
    }), /current Akinator question/i);

    const context = await getAkinatorContext(database, {
      workspace: 'project:current-question',
      sessionId: started.session.id,
    });
    assert.equal(context.question?.id, 'target');
    assert.equal(context.session.questionCount, 0);
    assert.deepEqual(context.entries, []);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM akinator_answers WHERE session_id = ?').get<{ count: number }>(started.session.id)?.count, 0);
  } finally {
    database.close();
  }
});

test('asks no more than three required questions before reaching ready', async () => {
  const database = await temporaryDatabase('akinator-three-questions');
  try {
    const started = await startAkinator(database, {
      workspace: 'project:three-questions',
      task: 'ambiguous request',
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'akinator-three-questions-fixed',
    });
    assert.equal(started.question?.id, 'taskType');
    const taskType = await answerAkinator(database, {
      workspace: 'project:three-questions', sessionId: started.session.id,
      questionId: 'taskType', value: 'build', now: '2026-08-20T00:01:00.000Z',
    });
    assert.equal(taskType.question?.id, 'target');
    const target = await answerAkinator(database, {
      workspace: 'project:three-questions', sessionId: started.session.id,
      questionId: 'target', value: 'src/index.ts', now: '2026-08-20T00:02:00.000Z',
    });
    assert.equal(target.question?.id, 'expected');
    const ready = await answerAkinator(database, {
      workspace: 'project:three-questions', sessionId: started.session.id,
      questionId: 'expected', value: 'tests pass', now: '2026-08-20T00:03:00.000Z',
    });
    assert.equal(ready.status, 'ready');
    assert.equal(ready.question, null);
    assert.equal(ready.session.questionCount, 3);
    assert.deepEqual(ready.missingFields, []);
  } finally {
    database.close();
  }
});

test('needs_answer context preserves the public response shape without retrieval or network work', async () => {
  const database = await temporaryDatabase('akinator-needs-answer');
  try {
    let fetchCalls = 0;
    const started = await startAkinator(database, {
      workspace: 'project:needs-answer',
      task: '実装する',
      now: '2026-08-20T00:00:00.000Z',
      idFactory: () => 'akinator-session-fixed',
    });
    assert.deepEqual(Object.keys(started).sort(), ['missingFields', 'question', 'recommendedTags', 'session', 'status']);
    assert.equal(started.session.id, 'akinator-session-fixed');
    assert.equal(started.status, 'needs_answer');
    assert.equal(started.question?.id, 'target');

    const context = await getAkinatorContext(database, {
      workspace: 'project:needs-answer',
      sessionId: started.session.id,
      fetchImpl: (async () => {
        fetchCalls += 1;
        throw new Error('network must not run while intake needs an answer');
      }) as typeof fetch,
    });
    assert.equal(context.status, 'needs_answer');
    assert.equal(context.question?.id, 'target');
    assert.deepEqual(context.entries, []);
    assert.deepEqual(context.externalSync, { attempted: false, imported: 0, sources: [] });
    assert.equal(fetchCalls, 0);
  } finally {
    database.close();
  }
});

test('falls back to current official source skills when local retrieval is insufficient', async () => {
  const database = await temporaryDatabase('akinator-source');
  try {
    const started = await startAkinator(database, {
      workspace: 'project:source',
      task: 'Implement a feature with tests',
      now: '2026-08-20T00:00:00.000Z',
    });
    const target = await answerAkinator(database, {
      workspace: 'project:source',
      sessionId: started.session.id,
      questionId: 'target',
      value: 'src/feature.ts',
      now: '2026-08-20T00:01:00.000Z',
    });
    const ready = await answerAkinator(database, {
      workspace: 'project:source',
      sessionId: started.session.id,
      questionId: target.question?.id ?? 'expected',
      value: 'The feature works and tests pass',
      now: '2026-08-20T00:02:00.000Z',
    });
    assert.equal(ready.status, 'ready');

    const context = await getAkinatorContext(database, {
      workspace: 'project:source',
      sessionId: started.session.id,
      allowExternalSkillFallback: true,
      fetchImpl: sourceFetch(),
      now: '2026-08-20T00:03:00.000Z',
    });
    assert.equal(context.externalSync.attempted, true);
    assert.ok(context.externalSync.imported >= 1);
    assert.ok(context.entries.some((entry) => entry.tags.includes('source:mattpocock-skills')));
    const imported = context.entries.find((entry) => entry.tags.includes('source:mattpocock-skills'));
    assert.equal(imported?.status, 'candidate');
    assert.equal(imported?.trustLevel, 'untrusted');
    assert.match(String(imported?.provenance.reference), /mattpocock-commit-1/);
  } finally {
    database.close();
  }
});
