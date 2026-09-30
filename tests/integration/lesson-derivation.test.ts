import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { exportWorkspace } from '../../src/commands/export.js';
import { openConnection } from '../../src/db/connection.js';
import { captureInteractionMemory } from '../../src/memory/interaction-capture.js';
import { deduplicateDeliverableLessonSources, deriveLessonCandidate, isDeliverableDerivedLesson, readDeliverableLessonSourceReferences } from '../../src/memory/lesson-derivation.js';
import { readEntry, recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { lessonReinforcement } from '../../src/memory/lesson-reinforcement.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { canonicalJson } from '../../src/serialization/validate.js';
import { recallEntries } from '../../src/memory/retrieval.js';
import { queryScopedContext } from '../../src/context/scoped-broker.js';
import { ContextBroker, readContextBrokerRunState } from '../../src/context/broker.js';
import { AgentGatewayService } from '../../src/gateway/agent-service.js';
import { recallScopedMemory } from '../../src/memory/scoped-memory.js';

const task = {
  soulRead: true,
  task: 'Fix SQLite migration retries after transient lock errors',
  capabilities: [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }],
  profileHints: { taskType: 'debug', target: 'SQLite migration retries', expected: 'Transient lock errors retry with a strict cap' },
} as const;

async function fixture(t: TestContext) {
  const base = await mkdtemp(path.join(tmpdir(), 'kiokuko-lesson-derivation-'));
  const root = path.join(base, 'repo');
  execFileSync('git', ['init', '-q', root]);
  const databasePath = path.join(base, 'memory.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  t.after(async () => { database.close(); await rm(base, { recursive: true, force: true }); });
  const project = await resolveProjectWorkspace(database, root);
  assert.ok(project);
  const source = recordEntry(database, {
    workspace: project.workspace,
    kind: 'fact',
    status: 'candidate',
    trustLevel: 'untrusted',
    confidence: 0.8,
    title: 'SQLite transient lock retries',
    body: 'For SQLite migration retries after transient lock errors, use bounded exponential backoff and stop after three attempts.',
    scope: buildStructuredScope({ visibility: 'project', retrievalScope: 'project-only', repositoryId: project.repositoryId }),
    createdBy: 'test',
  }, { idFactory: () => 'source-retry-policy', now: '2026-09-01T00:00:00.000Z' });
  const prepare = (requestId: string) => prepareAgentTask(database, {
    ...task,
    cwd: root,
    requestId,
    client: { kind: 'lesson-derivation-test' },
    skillDiscoveryMode: 'off',
  });
  return { root, database, project, source, prepare };
}

function deliverSource(database: ReturnType<typeof openConnection>, deliveryId: string, source: { id: string; revision: number }): void {
  const exists = database.prepare('SELECT 1 AS present FROM context_delivery_entries WHERE delivery_id = ? AND entry_id = ?')
    .get<{ present: number }>(deliveryId, source.id);
  if (exists) return;
  const rank = (database.prepare('SELECT COALESCE(MAX(rank), 0) + 1 AS rank FROM context_delivery_entries WHERE delivery_id = ?')
    .get<{ rank: number }>(deliveryId)!.rank);
  database.prepare(`INSERT INTO context_delivery_entries (
    delivery_id, entry_id, entry_revision, rank, score_components_json, selection_reason_json, origin_scope
  ) VALUES (?, ?, ?, ?, ?, ?, 'project')`).run(deliveryId, source.id, source.revision, rank,
    canonicalJson({ testFixture: 1 }), canonicalJson(['test_fixture']));
}

test('derivation is atomic, idempotent, untrusted and only later independent runs reinforce it', async (t) => {
  const f = await fixture(t);
  const firstRun = await f.prepare('derive-one');
  assert.ok(firstRun.context?.deliveryId);
  deliverSource(f.database, firstRun.context.deliveryId, f.source);
  const source = readEntry(f.database, { workspace: f.project!.workspace, entryId: f.source.id });
  const input = {
    operationId: 'derive-retry-policy',
    cwd: f.root,
    runId: firstRun.run.runId,
    deliveryId: firstRun.context.deliveryId,
    lesson: {
      title: 'Bound transient SQLite retries',
      body: 'Retry transient SQLite migration lock errors with bounded exponential backoff and stop after three attempts.',
      summary: 'Bounded retries avoid unending migration loops.',
    },
    sources: [{ workspace: source.workspace, entryId: source.id, revision: source.revision,
      contentHash: source.contentHash, role: 'experience' as const }],
  };
  const options = { cwd: f.root, clientKind: 'lesson-derivation-test', mode: 'active' as const };
  const saved = await deriveLessonCandidate(f.database, input, options);
  assert.ok('entryId' in saved);
  assert.equal(saved.outcome, 'created');
  assert.equal(saved.status, 'candidate');
  assert.equal(saved.trustLevel, 'untrusted');
  assert.equal(saved.reinforced, false);
  const lesson = readEntry(f.database, { workspace: f.project!.workspace, entryId: saved.entryId });
  assert.equal(lesson.provenance.type, 'agent_derived_lesson');
  assert.equal(lessonReinforcement(f.database, lesson).independentRuns, 0, 'creation must not count as an observation');
  assert.equal(isDeliverableDerivedLesson(f.database, lesson), true);
  assert.throws(() => exportWorkspace(f.database, { workspace: f.project!.workspace }), { code: 'CONFLICT' },
    'workspace archives cannot silently drop the revision-bound lesson sources');
  assert.deepEqual(await deriveLessonCandidate(f.database, input, options), {
    operationId: input.operationId, entryId: saved.entryId, revision: saved.revision,
    workspace: saved.workspace, outcome: 'replayed', availability: 'current',
  });
  await assert.rejects(deriveLessonCandidate(f.database, { ...input,
    lesson: { ...input.lesson, body: 'Different text with the same operation ID.' },
  }, options), { code: 'CONFLICT' });

  const secondRun = await f.prepare('derive-observation');
  const reinforced = await captureInteractionMemory(f.database, {
    runId: secondRun.run.runId,
    operationId: 'observe-derived-policy',
    memories: [{ kind: 'lesson', scope: 'project', title: 'Migration retry experience',
      body: 'The bounded three-attempt migration retry avoided a repeated lock failure.',
      subjects: ['sqlite migrations'], basis: 'observed_result',
      reinforces: { entryId: lesson.id, expectedRevision: lesson.revision } }],
  }, { cwd: f.root, clientKind: 'lesson-derivation-test' });
  assert.equal(reinforced.items[0]!.entryId, lesson.id);
  assert.deepEqual(reinforced.items[0]!.reinforcement, { independentRuns: 1, priority: 'normal', promoted: false });

  updateCandidateEntry(f.database, {
    workspace: f.project!.workspace, entryId: source.id, expectedRevision: source.revision,
    kind: 'fact', title: source.title, body: 'This source was corrected and no longer supports the derived retry lesson.',
    scope: source.scope, provenance: source.provenance, tags: source.tags, createdBy: 'test',
    now: '2026-09-02T00:00:00.000Z',
  });
  assert.equal(isDeliverableDerivedLesson(f.database, readEntry(f.database, {
    workspace: f.project!.workspace, entryId: lesson.id,
  })), false, 'source revision changes must withdraw the derived lesson from delivery');
});

test('disabled and observe derivation modes do not write entries, links, receipts or observations', async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare('derive-observe-only');
  assert.ok(prepared.context?.deliveryId);
  deliverSource(f.database, prepared.context.deliveryId, f.source);
  const source = readEntry(f.database, { workspace: f.project!.workspace, entryId: f.source.id });
  const input = { operationId: 'observe-only', cwd: f.root, runId: prepared.run.runId,
    deliveryId: prepared.context.deliveryId,
    lesson: { title: 'Possible lesson', body: 'This should stay out of the database in observe mode.' },
    sources: [{ workspace: source.workspace, entryId: source.id, revision: source.revision,
      contentHash: source.contentHash, role: 'evidence' as const }] };
  const before = f.database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()!.count;
  assert.deepEqual(await deriveLessonCandidate(f.database, input, { cwd: f.root,
    clientKind: 'lesson-derivation-test', mode: 'off' }), { enabled: false, mode: 'off', items: [] });
  const observed = await deriveLessonCandidate(f.database, input, { cwd: f.root,
    clientKind: 'lesson-derivation-test', mode: 'observe' });
  assert.ok('outcome' in observed);
  assert.equal(observed.outcome, 'would_save');
  assert.equal(observed.trustLevel, 'untrusted');
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()!.count, before);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM lesson_derivation_operations').get<{ count: number }>()!.count, 0);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM lesson_observations').get<{ count: number }>()!.count, 0);
});

test('duplicate suppression requires an exact deliverable lesson and keeps revision-bound source references', async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepare('derive-exact-duplicate');
  assert.ok(prepared.context?.deliveryId);
  const source = recordEntry(f.database, {
    workspace: f.project!.workspace, kind: 'lesson', status: 'candidate', trustLevel: 'untrusted', confidence: 0.6,
    title: 'Bound retry policy', body: 'Use three bounded retries for transient SQLite migration locks.',
    summary: 'Stop after three retry attempts.',
    scope: buildStructuredScope({ visibility: 'project', retrievalScope: 'project-only', repositoryId: f.project!.repositoryId }),
    createdBy: 'test',
  }, { idFactory: () => 'zzzz-exact-duplicate-source' });
  const broker = new ContextBroker(f.database);
  const deliveredSourceContext = await broker.query({ workspace: f.project!.workspace, runId: prepared.run.runId,
    limit: 10, characterBudget: 4_000, relatedMode: 'off' });
  assert.equal(deliveredSourceContext.context?.items.some((item) => item.entryId === source.id), true,
    'the source must be part of a real generic delivery before derivation');
  assert.ok(deliveredSourceContext.context?.deliveryId);
  const input = {
    operationId: 'exact-duplicate-derived', cwd: f.root, runId: prepared.run.runId,
    deliveryId: deliveredSourceContext.context.deliveryId,
    lesson: { title: source.title, body: source.body, summary: source.summary },
    sources: [{ workspace: source.workspace, entryId: source.id, revision: source.revision,
      contentHash: source.contentHash, role: 'experience' as const }],
  };
  const saved = await deriveLessonCandidate(f.database, input, {
    cwd: f.root, clientKind: 'lesson-derivation-test', mode: 'active',
  });
  assert.ok('entryId' in saved);
  const derived = readEntry(f.database, { workspace: f.project!.workspace, entryId: saved.entryId });
  assert.equal(isDeliverableDerivedLesson(f.database, derived), true);
  assert.deepEqual({ kind: derived.kind, title: derived.title, body: derived.body, summary: derived.summary, tags: derived.tags },
    { kind: source.kind, title: source.title, body: source.body, summary: source.summary, tags: source.tags });
  const candidates = [source, derived];
  assert.equal(deduplicateDeliverableLessonSources(f.database, candidates, 'off').entries.length, 2);
  const observed = deduplicateDeliverableLessonSources(f.database, candidates, 'observe');
  assert.equal(observed.entries.length, 2);
  assert.equal(observed.diagnostics.duplicatePairs, 1);
  assert.equal(observed.diagnostics.suppressedCount, 0);
  const active = deduplicateDeliverableLessonSources(f.database, candidates, 'active');
  assert.deepEqual(active.entries.map((entry) => entry.id), [derived.id]);
  assert.equal(active.suppressed[0]?.retainedEntryId, derived.id);
  assert.equal(readDeliverableLessonSourceReferences(f.database, derived)[0]?.contentHash, source.contentHash);
  const derivedFirst = deduplicateDeliverableLessonSources(f.database, [derived, source], 'active');
  assert.deepEqual(derivedFirst.entries.map((entry) => entry.id), [derived.id]);
  assert.match(derivedFirst.sourceReferences.get(derived.id)?.[0]?.entryId ?? '', /exact-duplicate-source/u);

  const linkedOnly = recordEntry(f.database, {
    workspace: f.project!.workspace, kind: 'lesson', status: 'candidate', trustLevel: 'untrusted', confidence: 0.6,
    title: `${source.title} proposal`, body: source.body, summary: source.summary,
    scope: source.scope, createdBy: 'test',
  }, { idFactory: () => 'untrusted-claimed-duplicate' });
  f.database.prepare(`INSERT INTO entry_links (from_entry_id, to_entry_id, relation, created_at, created_by)
    VALUES (?, ?, 'derived_from', ?, 'test')`).run(linkedOnly.id, source.id, new Date().toISOString());
  assert.equal(deduplicateDeliverableLessonSources(f.database, [source, linkedOnly], 'active').entries.length, 2,
    'a similar or linked entry without a valid derivation receipt cannot suppress the source');

  const previousMode = process.env.KIOKUKO_SEARCH_EXPANSION_MODE;
  process.env.KIOKUKO_SEARCH_EXPANSION_MODE = 'active';
  t.after(() => {
    if (previousMode === undefined) delete process.env.KIOKUKO_SEARCH_EXPANSION_MODE;
    else process.env.KIOKUKO_SEARCH_EXPANSION_MODE = previousMode;
  });
  const recall = recallEntries(f.database, {
    workspace: f.project!.workspace, query: 'three bounded retries transient SQLite migration locks', limit: 10, relatedMode: 'active',
  });
  assert.equal(recall.items.some((item) => item.id === derived.id), true);
  assert.equal(recall.items.some((item) => item.id === source.id), false);
  assert.match(recall.items.find((item) => item.id === derived.id)!.snippet, /Revision-verified sources:/u);
  assert.equal(recall.lessonDeduplicationDiagnostics?.suppressedCount, 1);

  const federatedRecall = await recallScopedMemory(f.database, {
    cwd: f.root, query: 'three bounded retries transient SQLite migration locks',
    scope: 'project', limit: 10, maxChars: 4_000, relatedMode: 'active',
  });
  const projectRecall = federatedRecall.project?.memory.items ?? [];
  assert.equal(projectRecall.some((item) => item.id === derived.id), true);
  assert.equal(projectRecall.some((item) => item.id === source.id), false);
  assert.match(projectRecall.find((item) => item.id === derived.id)!.snippet, /Revision-verified sources:/u);
  assert.equal(federatedRecall.lessonDeduplicationDiagnostics?.suppressedCount, 1);

  const runContext = readContextBrokerRunState(f.database, prepared.run.runId);
  const scopedInput = {
    project: f.project!,
    runId: prepared.run.runId,
    task: 'Use three bounded retries for transient SQLite migration locks.',
    taskProfile: runContext.taskProfile,
    limit: 10,
    characterBudget: 4_000,
    relatedMode: 'active',
  } as const;
  const scoped = await queryScopedContext(f.database, scopedInput);
  assert.equal(scoped.items.some((item) => item.entryId === derived.id), true);
  assert.equal(scoped.items.some((item) => item.entryId === source.id), false);
  assert.match(scoped.items.find((item) => item.entryId === derived.id)!.bodyPreview, /Revision-verified sources:/u);
  assert.equal(scoped.lessonDeduplicationDiagnostics?.suppressedCount, 1);
  const scopedReplay = await queryScopedContext(f.database, scopedInput);
  assert.deepEqual(scopedReplay.items, scoped.items, 'scoped replay restores the complete source note and exact budget accounting');

  const genericRun = new AgentGatewayService(f.database).openRun({
    idempotencyKey: 'generic-lesson-use',
    request: {
      apiVersion: '1', workspace: f.project!.workspace, client: { kind: 'lesson-derivation-test' },
      task: { title: 'Use the bounded retry policy', query: 'Use three bounded retries for transient SQLite migration locks.',
        profileHints: { taskType: 'debug', target: 'Bound retry policy', expected: 'Stop after three retry attempts' } },
      captureProfile: 'minimal',
      coverage: { run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete' },
      metadata: {},
    },
  });
  const genericInput = { workspace: f.project!.workspace, runId: genericRun.runId, limit: 10,
    characterBudget: 4_000, relatedMode: 'active' as const };
  const generic = await broker.query(genericInput);
  assert.equal(generic.status, 'ready');
  assert.equal(generic.context?.items.some((item) => item.entryId === derived.id), true);
  assert.equal(generic.context?.items.some((item) => item.entryId === source.id), false);
  assert.match(generic.context?.items.find((item) => item.entryId === derived.id)?.content.bodyPreview ?? '', /Revision-verified sources:/u);
  assert.equal(generic.lessonDeduplicationDiagnostics?.suppressedCount, 1);
  const genericReplay = await broker.query(genericInput);
  assert.deepEqual(genericReplay.context?.items.map((item) => ({
    entryId: item.entryId, revision: item.entryRevision, content: item.content,
  })), generic.context?.items.map((item) => ({
    entryId: item.entryId, revision: item.entryRevision, content: item.content,
  })), 'generic delivery replay reconstructs the complete source reference under the same budget');
});
