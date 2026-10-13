import { createHash } from 'node:crypto';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { LedgerStore } from '../ledger/store.js';
import { canonicalJson, type JsonObject } from '../serialization/validate.js';
import { observationSchema, memoryContextSchema, memoryImproveSchema, type MemoryObservation, type MemoryContextResponse, type MemoryContextItem, type MemoryRecordResponse } from './observation-contract.js';
import { recordEntryInTransaction, updateCandidateEntryInTransaction, readEntry, type EntryRecord } from './entries.js';
import { findSecretInValue } from './secrets.js';
import { resolveProjectWorkspace, ensureGlobalWorkspace, GLOBAL_WORKSPACE } from './workspaces.js';
import { recallEntries } from './retrieval.js';

const actor = 'kiokuko-observer';
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
interface Head extends SqliteRow { workspace: string; producer: string; source_id: string; source_revision: number;
  content_hash: string; ledger_event_id: string; entry_id: string; session_id: string; kind: string;
  tombstone: number; payload_json: string; updated_at: string; }
const failure = (warning: string) => ({ accepted: false, recorded: false, workMayContinue: true as const, warnings: [warning] });
const tagsFor = (event: MemoryObservation) => [...new Set([event.kind, ...event.tags.map(tag => tag.toLowerCase())])].sort();
const publicText = (value: string) => value.replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/gu, '[personal]')
  .replace(/(?:\/Users\/|\/home\/)[^\s]+/gu, '[local-path]');
function projection(event: MemoryObservation) {
  return { ...event, summary: publicText(event.summary), tags: tagsFor(event),
    ...(event.issue === undefined ? {} : { issue: publicText(event.issue) }),
    ...(event.prevention === undefined ? {} : { prevention: publicText(event.prevention) }),
    actions: event.actions.map(action => ({ ...action, summary: publicText(action.summary) })) };
}
function entryInput(event: MemoryObservation, workspace: string, ledgerId: string) {
  const withdrawn = event.source.tombstone;
  const summary = withdrawn ? 'Source observation withdrawn.' : event.summary;
  return { workspace, kind: 'reference' as const, title: `Recorded ${event.kind}`,
    body: withdrawn ? summary : JSON.stringify({ summary, actions: event.actions, issue: event.issue,
      prevention: event.prevention, outcome: event.outcome, verification: event.verification }), summary,
    tags: withdrawn ? ['withdrawn-source'] : tagsFor(event),
    scope: { visibility: 'project' }, provenance: { type: 'passive_observation', reference: ledgerId,
      evidenceIds: [ledgerId], clientKind: event.source.producer }, trustLevel: 'untrusted' as const,
    confidence: withdrawn ? 0 : event.verification === 'passed' ? 0.6 : event.verification === 'failed' ? 0.4 : 0.25,
    createdBy: actor, actor };
}
export async function observeMemory(db: SqliteDatabase, raw: unknown): Promise<MemoryRecordResponse> {
  try {
    const parsed = observationSchema.safeParse(raw);
    if (!parsed.success) return failure('memory_input_invalid');
    if (findSecretInValue(parsed.data)) return failure('memory_input_contains_secret');
    const event = projection(parsed.data);
    const project = await resolveProjectWorkspace(db, event.cwd);
    if (!project) return failure('memory_repository_unavailable');
    const workspace = project.workspace;
    event.cwd = project.repositoryRoot;
    const fingerprint = hash(event);
    return withImmediateTransaction(db, () => {
      const prior = db.prepare('SELECT * FROM memory_observation_heads WHERE workspace=? AND producer=? AND source_id=?')
        .get<Head>(workspace, event.source.producer, event.eventId);
      if (prior && event.source.revision < prior.source_revision) return failure('stale_source_revision');
      if (prior && event.source.revision === prior.source_revision) return prior.content_hash === fingerprint
        ? { accepted: true, recorded: true, duplicate: true, workMayContinue: true as const, entryId: prior.entry_id, warnings: [] }
        : failure('source_revision_conflict');
      const store = new LedgerStore(db);
      const runId = `observation-${hash(workspace).slice(0, 32)}`;
      if (!store.readRun(runId)) {
        store.createRunInTransaction({ runId, workspace, protocolVersion: '1', client: { kind: actor },
          captureProfile: 'minimal', coverage: { run: 'best_effort', tool: 'declared', command: 'declared', file: 'declared', approval: 'unavailable' },
          task: { title: 'Passive observations', query: 'Recorded public actions and outcomes', profileHints: { taskType: null, target: null, expected: null, constraints: null } },
          metadata: { purpose: 'passive-memory', intakeRequired: false } });
        store.updateRunStatusInTransaction(runId, 'active');
      }
      const ledgerId = `observation-${hash([workspace, event.source.producer, event.eventId, event.source.revision])}`;
      store.appendBatchInTransaction(runId, { events: [{ eventId: ledgerId,
        sourceEventId: `${event.source.producer}:${event.eventId}:${event.source.revision}`,
        eventType: 'source.event', sourceType: event.kind, actor, payload: event }] });
      const input = entryInput(event, workspace, ledgerId);
      let entry: EntryRecord;
      if (prior) {
        const current = readEntry(db, { workspace, entryId: prior.entry_id });
        entry = updateCandidateEntryInTransaction(db, { ...input, entryId: current.id, expectedRevision: current.revision });
        db.prepare('UPDATE entries SET confidence=? WHERE id=? AND workspace=?').run(input.confidence, entry.id, workspace);
      } else entry = recordEntryInTransaction(db, input);
      db.prepare(`INSERT INTO memory_observation_heads VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(workspace,producer,source_id) DO UPDATE SET source_revision=excluded.source_revision,
        content_hash=excluded.content_hash,ledger_event_id=excluded.ledger_event_id,entry_id=excluded.entry_id,
        session_id=excluded.session_id,kind=excluded.kind,tombstone=excluded.tombstone,payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
        .run(workspace, event.source.producer, event.eventId, event.source.revision, fingerprint, ledgerId, entry.id,
          event.sessionId, event.kind, event.source.tombstone ? 1 : 0, JSON.stringify(event), new Date().toISOString());
      return { accepted: true, recorded: true, duplicate: false, workMayContinue: true as const, entryId: entry.id,
        sourceEventId: ledgerId, sourceRevision: event.source.revision, warnings: [] };
    });
  } catch { return failure('memory_storage_unavailable'); }
}
function contextItem(entry: EntryRecord, scope: 'project' | 'global'): MemoryContextItem {
  let body: Record<string, unknown> = {};
  try { const decoded: unknown = JSON.parse(entry.body); if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) body = decoded as Record<string, unknown>; } catch { /* Legacy prose is advisory. */ }
  const value = body.verification;
  const actions = observationSchema.shape.actions.safeParse(body.actions);
  return { entryId: entry.id, revision: entry.revision, kind: entry.kind, summary: entry.summary ?? entry.body.slice(0, 2048),
    tags: entry.tags, confidence: entry.confidence,
    verification: value === 'passed' || value === 'failed' ? value : 'unknown',
    verificationProvenance: value === 'passed' || value === 'failed' ? 'declared' : 'unknown',
    sourceEventIds: Array.isArray(entry.provenance.evidenceIds) ? entry.provenance.evidenceIds.filter((id): id is string => typeof id === 'string') : [],
    ...(actions.success ? { actions: actions.data } : {}),
    ...(typeof body.issue === 'string' ? { issue: body.issue } : {}),
    ...(typeof body.prevention === 'string' ? { prevention: body.prevention } : {}),
    scope, untrusted: true };
}
export async function memoryContext(db: SqliteDatabase, raw: unknown): Promise<MemoryContextResponse> {
  const empty = (warning: string): MemoryContextResponse => ({ available: false, workMayContinue: true,
    entries: [], handoff: null, warnings: [warning] });
  try {
    const parsed = memoryContextSchema.safeParse(raw);
    if (!parsed.success) return empty('memory_input_invalid');
    const input = parsed.data, project = await resolveProjectWorkspace(db, input.cwd);
    if (!project) return empty('memory_repository_unavailable');
    const rows = recallEntries(db, { workspace: project.workspace, query: input.query, limit: 50, maxChars: 48000, ...(input.tags[0] ? { tag: input.tags[0].toLowerCase() } : {}) });
    const entries: MemoryContextItem[] = [];
    for (const hit of rows.items) {
      const entry = readEntry(db, { workspace: project.workspace, entryId: hit.id });
      const head = db.prepare('SELECT tombstone,kind FROM memory_observation_heads WHERE entry_id=?').get<{ tombstone: number; kind: string }>(entry.id);
      if (head?.tombstone || (head && ['model_switch', 'compaction'].includes(head.kind)) || input.tags.some(tag => !entry.tags.includes(tag.toLowerCase()))) continue;
      entries.push(contextItem(entry, 'project'));
    }
    for (const row of db.prepare(`SELECT e.id FROM memory_principle_references p JOIN entries e ON e.id=p.entry_id WHERE e.status='candidate' AND p.evidence_hash<>'withdrawn' LIMIT ?`).all<{ id: string }>(input.limit)) {
      const entry = readEntry(db, { workspace: GLOBAL_WORKSPACE, entryId: row.id });
      if (input.query && !`${entry.title} ${entry.body}`.toLowerCase().includes(input.query.toLowerCase())) continue;
      if (input.tags.some(tag => !entry.tags.includes(tag.toLowerCase()))) continue;
      entries.push(contextItem(entry, 'global'));
    }
    let handoff: MemoryContextResponse['handoff'] = null;
    if (input.sessionId) {
      const row = db.prepare(`SELECT * FROM memory_observation_heads WHERE workspace=? AND session_id=? AND tombstone=0
        AND kind IN ('compaction','model_switch','completion')
        AND NOT EXISTS (SELECT 1 FROM json_each(payload_json,'$.tags') WHERE value='lifecycle-signal') ORDER BY updated_at DESC LIMIT 1`).get<Head>(project.workspace, input.sessionId);
      if (row && Date.now() - Date.parse(row.updated_at) < 24 * 60 * 60 * 1000) {
        const event = observationSchema.parse(JSON.parse(row.payload_json));
        handoff = { sessionId: input.sessionId, summary: event.summary, tags: event.tags, sourceEventIds: [row.ledger_event_id],
          updatedAt: row.updated_at, expiresAt: new Date(Date.parse(row.updated_at) + 24 * 60 * 60 * 1000).toISOString() };
      }
    }
    return { available: true, workMayContinue: true, entries: entries.slice(0, input.limit), handoff, warnings: [] };
  } catch { return empty('memory_context_unavailable'); }
}
export async function improveMemory(db: SqliteDatabase, raw: unknown): Promise<MemoryRecordResponse> {
  try {
    const parsed = memoryImproveSchema.safeParse(raw);
    if (!parsed.success) return failure('memory_input_invalid');
    const input = parsed.data, project = await resolveProjectWorkspace(db, input.cwd);
    if (!project) return failure('memory_repository_unavailable');
    const heads = db.prepare('SELECT * FROM memory_observation_heads WHERE workspace=? AND tombstone=0 ORDER BY updated_at DESC LIMIT ?')
      .all<Head>(project.workspace, input.limit);
    const events = heads.map(head => ({ head, event: observationSchema.parse(JSON.parse(head.payload_json)) }));
    const complaints = events.filter(({ event }) => event.kind === 'complaint');
    const completions = events.filter(({ event }) => event.kind === 'completion');
    const independent = new Set(completions.map(({ event }) => event.source.runId ?? event.sessionId));
    const rules: Array<{ key: string; title: string; body: string; sources: Head[]; confidence: number }> = [];
    if (complaints.length) rules.push({ key: 'recorded-failure-prevention', title: 'Keep failure conditions and prevention separate',
      body: 'Treat a reported failure as a caution candidate. Preserve the observed condition and check the prevention against new execution evidence before reusing a procedure.',
      sources: complaints.map(({ head }) => head), confidence: 0.3 });
    if (independent.size >= 2) rules.push({ key: 'repeat-completion-candidate', title: 'Verify repeated procedures independently',
      body: 'Repeated completion signals can suggest a routine. Silence or praise is not verification; check current recorded outcomes, failure feedback and independent verification before reuse.',
      sources: [...completions, ...complaints].map(({ head }) => head), confidence: complaints.length ? 0.25 : completions.every(({ event }) => event.verification === 'passed') ? 0.6 : 0.3 });
    const praise = events.filter(({ event }) => event.kind === 'praise' && event.actions.length > 0);
    if (praise.length) rules.push({ key: 'recorded-success-procedure', title: 'Reuse recorded actions with their evidence limits',
      body: 'A praised procedure is a reusable candidate only to the extent its recorded actions and outcomes support it. Preserve verification limits and check new conditions instead of inferring success from praise.',
      sources: praise.map(({ head }) => head), confidence: 0.4 });
    return withImmediateTransaction(db, () => {
      ensureGlobalWorkspace(db);
      let saved = 0;
      for (const rule of rules) {
        const sourceEventIds = [...new Set(rule.sources.map(head => head.ledger_event_id))].sort();
        const evidenceHash = hash([sourceEventIds, rule.confidence]);
        const key = `${hash(project.workspace)}:${rule.key}`;
        const prior = db.prepare('SELECT entry_id,evidence_hash FROM memory_principle_references WHERE principle_key=?')
          .get<{ entry_id: string; evidence_hash: string }>(key);
        if (prior?.evidence_hash === evidenceHash) continue;
        const entry = { workspace: GLOBAL_WORKSPACE, kind: 'reference' as const, title: rule.title, body: JSON.stringify({ principle: rule.body, sourceEventIds,
            counterexampleEventIds: complaints.map(({ head }) => head.ledger_event_id), verification: 'unknown',
            confidence: rule.confidence, extraction: 'deterministic-v1' }),
          summary: rule.body, tags: ['principle-candidate', 'workflow', 'verification'], trustLevel: 'untrusted' as const,
          scope: { visibility: 'global', portability_reason: 'General workflow principle; no project text or personal content is copied.' },
          provenance: { type: 'passive_principle', reference: key, evidenceIds: sourceEventIds, sourceSetHash: evidenceHash },
          confidence: rule.confidence, createdBy: actor, actor };
        let record: EntryRecord;
        if (prior) {
          const current = readEntry(db, { workspace: GLOBAL_WORKSPACE, entryId: prior.entry_id });
          record = updateCandidateEntryInTransaction(db, { ...entry, entryId: current.id, expectedRevision: current.revision });
          db.prepare('UPDATE entries SET confidence=? WHERE id=? AND workspace=?').run(rule.confidence, record.id, GLOBAL_WORKSPACE);
        } else record = recordEntryInTransaction(db, entry);
        db.prepare('INSERT INTO memory_principle_references VALUES(?,?,?) ON CONFLICT(principle_key) DO UPDATE SET entry_id=excluded.entry_id,evidence_hash=excluded.evidence_hash')
          .run(key, record.id, evidenceHash); saved++;
      }
      let withdrawn = 0;
      const activeKeys = new Set(rules.map(rule => `${hash(project.workspace)}:${rule.key}`));
      for (const prior of db.prepare('SELECT * FROM memory_principle_references WHERE principle_key LIKE ? AND evidence_hash<>?')
        .all<{ principle_key: string; entry_id: string }>(`${hash(project.workspace)}:%`, 'withdrawn')) {
        if (activeKeys.has(prior.principle_key)) continue;
        const current = readEntry(db, { workspace: GLOBAL_WORKSPACE, entryId: prior.entry_id });
        // Only the observer's own candidate may be retracted. Preserve its
        // previous revision and links; a withdrawal is not a new principle.
        if (current.status !== 'candidate' || current.createdBy !== actor) continue;
        updateCandidateEntryInTransaction(db, { workspace: GLOBAL_WORKSPACE, entryId: current.id,
          expectedRevision: current.revision, kind: current.kind, title: 'Source support withdrawn',
          body: 'Current source observations no longer support this candidate.', summary: 'Source support withdrawn.',
          scope: current.scope, provenance: current.provenance, tags: ['withdrawn-source'], actor, createdBy: actor });
        db.prepare('UPDATE entries SET confidence=0 WHERE id=?').run(current.id);
        db.prepare('UPDATE memory_principle_references SET evidence_hash=? WHERE principle_key=?').run('withdrawn', prior.principle_key);
        withdrawn++;
      }
      return { accepted: true, recorded: true, workMayContinue: true as const, saved, withdrawn, warnings: [],
        verification: 'unknown' as const, untrusted: true as const };
    });
  } catch { return failure('memory_improvement_unavailable'); }
}
