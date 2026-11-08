import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { handleCodexHook } from '../../src/assurance/codex-hooks.js';
import { considerPendingCaptureReservations } from '../../src/memory/capture-consideration.js';
import { reviewPendingCaptureCandidate } from '../../src/memory/capture-pending-review.js';
import { memoryContext } from '../../src/memory/observations.js';
import { extractReplayProposal } from '../../src/memory/replay-extract.js';
import { proposalDigest } from '../../src/memory/replay-review.js';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';

interface Fixture { base: string; root: string; databasePath: string; db: ReturnType<typeof openConnection>; cleanup(): void; }
function fixture(options: { runs?: boolean } = {}): Fixture {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'kiokuko-capture-')));
  execFileSync('git', ['init', '-q', base]);
  const databasePath = path.join(base, 'memory.sqlite3');
  const db = openConnection(databasePath);
  migrateDatabase(db);
  if (options.runs !== false) mkdirSync(path.join(base, '.agenticreplay', 'runs'), { recursive: true });
  const env = { CODEX_HOME: process.env.CODEX_HOME, AGENTICREPLAY_CODEX_REVIEW_SOCKET: process.env.AGENTICREPLAY_CODEX_REVIEW_SOCKET };
  process.env.CODEX_HOME = path.join(base, 'codex');
  process.env.AGENTICREPLAY_CODEX_REVIEW_SOCKET = path.join(base, 'no-recorder.sock');
  return { base, root: base, databasePath, db, cleanup() {
    try { db.close(); } catch { /* already closed */ }
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(base, { recursive: true, force: true });
  } };
}
const line = (seq: number, type: string, attrs: Record<string, unknown>, payload?: unknown, causes?: number[]) => ({
  seq, ts: '2026-11-07T00:00:00Z', mono_us: seq, turn: 1, type, actor: 'tool', attrs, ...(payload === undefined ? {} : { payload }), ...(causes === undefined ? {} : { causes }),
});
const desktopDirectoryName = (runId: string) => `20261107000000-codex-desktop-api-codex-turn-${runId.slice(4)}`;
function writeTrace(root: string, runId: string, events: unknown[], options: { desktop?: boolean } = {}): void {
  const name = options.desktop ? desktopDirectoryName(runId) : runId;
  const directory = path.join(root, '.agenticreplay', 'runs', name);
  mkdirSync(directory, { recursive: true });
  const bytes = events.map(line => JSON.stringify(line)).join('\n') + '\n';
  writeFileSync(path.join(directory, 'events.jsonl'), bytes);
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    schema_version: '0.4.0', run_id: runId, cwd: root,
    ...(options.desktop ? { adapter: { id: 'codex-desktop-api' }, capture: { status: 'complete' } } : {}),
    integrity: { events_sha256: createHash('sha256').update(bytes).digest('hex') },
  }));
}
const requestText = '毎回 npm test を先に走らせてから報告して。';
const transcriptPath = (root: string, sessionId = 'session-a') => path.join(root, 'codex', 'sessions', `rollout-fixture-${sessionId}.jsonl`);
function writeTranscript(root: string, turnId = 'turn-1', completed = true) {
  const file = transcriptPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const event = (type: string) => ({ type: 'event_msg', payload: { type, turn_id: turnId, root_turn_id: turnId,
    started_at: 1, completed_at: 2 } });
  const records = [
    { type: 'session_meta', payload: { id: 'session-a', cwd: root, originator: 'codex_work_desktop' } },
    event('task_started'),
    { type: 'turn_context', payload: { turn_id: turnId, cwd: root } },
    ...(completed ? [event('task_complete')] : []),
  ];
  writeFileSync(file, records.map(record => JSON.stringify(record) + '\n').join(''));
}
const recordedTrace = (root: string, runId = 'run_abcdef', options: { sessionId?: string; turnId?: string; empty?: boolean; blobs?: unknown[] } = {}) => {
  const sessionId = options.sessionId ?? 'session-a';
  const turnId = options.turnId ?? 'turn-1';
  const requestId = 'wire-request';
  const output = options.empty ? [] : [
    { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'npm test passed.' }] },
  ];
  writeTrace(root, runId, [
    line(0, 'run.start', { source: 'codex-desktop-api', sessionId, turnId }),
    line(1, 'model.request', { request_id: requestId }, { input: options.empty ? [] : [
      { role: 'user', metadata: { turn_id: turnId }, content: [{ type: 'input_text', text: requestText }] },
    ] }),
    line(2, 'net.request', { request_id: requestId, headers: {
      'x-codex-turn-metadata': JSON.stringify({ thread_id: sessionId, turn_id: turnId }),
    } }),
    line(3, 'net.response', { request_id: requestId, response_complete: true, capture_incomplete: false }, undefined, [2]),
    line(4, 'model.response', { request_id: requestId }, 'data: ' + JSON.stringify({
      type: 'response.completed', response: { status: 'completed', output },
    }) + '\n\n'),
    ...(options.blobs ?? []).map((blob, index) => line(index + 5, 'user.message', {}, blob)),
    line((options.blobs?.length ?? 0) + 5, 'run.end', {}),
  ], { desktop: true });
  writeTranscript(root);
};
const hookInput = (root: string, hook_event_name: string, turn_id = 'turn-1', extra: Record<string, unknown> = {}) =>
  ({ hook_event_name, session_id: 'session-a', turn_id, cwd: root,
    ...(turn_id === 'turn-1' && process.env.CODEX_HOME ? { transcript_path: transcriptPath(root) } : {}), ...extra });
type Db = Fixture['db'];
const reservations = (db: Db) => db
  .prepare('SELECT event_id, state, repository_root, session_id, turn_id, attempts FROM memory_capture_reservations')
  .all<Record<string, string | number>>();
const candidateRows = (db: Db) => db
  .prepare('SELECT candidate_id, event_id, workspace, session_id, turn_id, evidence_key, revision, digest, proposal_json, state, presented_at FROM memory_capture_candidates')
  .all<Record<string, string | number | null>>();

const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];

test('Stop without a memory run reserves one candidate consideration per turn and stays silent', () => {
  const f = fixture();
  try {
    recordedTrace(f.root);
    const prompt = handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit')) as Record<string, unknown>;
    assert.equal(prompt.continue, undefined);
    assert.deepEqual(handleCodexHook(f.db, hookInput(f.root, 'Stop')), {}); // No candidates yet: no notification.
    const rows = reservations(f.db);
    assert.equal(rows.length, 1);
    assert.match(String(rows[0]!.event_id), /^codex-[a-f0-9]{64}$/u);
    assert.equal(rows[0]!.state, 'pending');
    assert.equal(rows[0]!.repository_root, f.root);
    assert.equal(rows[0]!.session_id, 'session-a');
    assert.equal(rows[0]!.turn_id, 'turn-1');
    // Replayed completion events never duplicate the reservation.
    handleCodexHook(f.db, hookInput(f.root, 'Stop'));
    // Child-agent completion is not a main-turn completion.
    handleCodexHook(f.db, hookInput(f.root, 'SubagentStop', 'turn-1', { agent_id: 'child' }));
    assert.equal(reservations(f.db).length, 1);
  } finally { f.cleanup(); }
});

test('a turn without recorded evidence is classified evidence-insufficient, never a candidate', async () => {
  const f = fixture({ runs: false });
  try {
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit'));
    handleCodexHook(f.db, hookInput(f.root, 'Stop', 'turn-1', { transcript_path: undefined }));
    const rows = reservations(f.db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.state, 'evidence_insufficient');
    const receipt = await considerPendingCaptureReservations(f.db, f.root);
    assert.equal(receipt.considered, 0);
    assert.equal(candidateRows(f.db).length, 0);
    // The next completed turn stays silent: an unconsiderable turn is not a candidate.
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit', 'turn-2'));
    assert.deepEqual(handleCodexHook(f.db, hookInput(f.root, 'Stop', 'turn-2')), {});
  } finally { f.cleanup(); }
});

test('consideration stores a bounded pending candidate without saving any memory', async () => {
  const f = fixture();
  try {
    recordedTrace(f.root);
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit'));
    handleCodexHook(f.db, hookInput(f.root, 'Stop'));
    const receipt = await considerPendingCaptureReservations(f.db, f.root);
    assert.equal(receipt.considered, 1);
    assert.equal(receipt.created, 1);
    assert.equal(reservations(f.db)[0]!.state, 'useful_candidates');
    const rows = candidateRows(f.db);
    assert.equal(rows.length, 1);
    assert.match(String(rows[0]!.evidence_key), /^run_abcdef:[a-f0-9]{64}$/u);
    assert.equal(rows[0]!.state, 'pending_review');
    assert.equal(String(rows[0]!.workspace).startsWith('project:'), true);
    const proposal = JSON.parse(String(rows[0]!.proposal_json));
    assert.ok(proposal.findings.length >= 1);
    assert.ok(proposal.source.traces[0]!.eventsSha256);
    // Unapproved candidates are not memories: never saved, never recallable.
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, 0);
    const context = await memoryContext(f.db, { cwd: f.root, query: 'npm test' });
    assert.deepEqual(context.entries, []);
    // Re-running the dedicated consideration never duplicates the candidate.
    const again = await considerPendingCaptureReservations(f.db, f.root);
    assert.equal(again.considered, 0);
    assert.equal(again.created, 0);
    assert.equal(candidateRows(f.db).length, 1);
  } finally { f.cleanup(); }
});

test('an unusable trace is evidence-insufficient with a bounded warning, not a silent skip', async () => {
  const f = fixture();
  try {
    writeTranscript(f.root);
    // The manifest seals the valid bytes; appended corruption breaks integrity.
    const directory = path.join(f.root, '.agenticreplay', 'runs', 'run_abcdef');
    mkdirSync(directory, { recursive: true });
    const valid = [line(1, 'user.message', {}, { text: '壊れる前の記録' })].map(event => JSON.stringify(event)).join('\n') + '\n';
    writeFileSync(path.join(directory, 'events.jsonl'), valid);
    writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
      schema_version: '0.4.0', run_id: 'run_abcdef', cwd: f.root,
      integrity: { events_sha256: createHash('sha256').update(valid).digest('hex') },
    }));
    appendFileSync(path.join(directory, 'events.jsonl'), '{}\n');
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit'));
    handleCodexHook(f.db, hookInput(f.root, 'Stop'));
    const receipt = await considerPendingCaptureReservations(f.db, f.root);
    assert.equal(receipt.created, 0);
    assert.deepEqual(receipt.warnings, ['replay_integrity_mismatch']);
    assert.equal(reservations(f.db)[0]!.state, 'evidence_insufficient');
  } finally { f.cleanup(); }
});

test('the next turn offers the native review only in the originating chat', async () => {
  const f = fixture();
  try {
    recordedTrace(f.root);
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit'));
    handleCodexHook(f.db, hookInput(f.root, 'Stop'));
    await considerPendingCaptureReservations(f.db, f.root);
    const notified = JSON.stringify(handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit', 'turn-2')));
    assert.match(notified, /memory_review_pending once/u);
    assert.doesNotMatch(notified, /npm test を先に/u);
    const other = JSON.stringify(handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit', 'turn-2', { session_id: 'other-chat' })));
    assert.doesNotMatch(other, /memory_review_pending once/u);
    assert.deepEqual(handleCodexHook(f.db, hookInput(f.root, 'Stop', 'turn-2')), {});
    assert.equal(candidateRows(f.db).filter(candidate => candidate.state === 'pending_review').length, 1);
  } finally { f.cleanup(); }
});

test('decline saves nothing and the same evidence is never re-proposed', async () => {
  const f = fixture();
  try {
    recordedTrace(f.root);
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit'));
    handleCodexHook(f.db, hookInput(f.root, 'Stop'));
    await considerPendingCaptureReservations(f.db, f.root);
    const row = candidateRows(f.db).find(candidate => candidate.state === 'pending_review')!;
    const proposal = JSON.parse(String(row.proposal_json));
    const declined = await reviewPendingCaptureCandidate(f.db, {
      candidateId: String(row.candidate_id), workspace: proposal.source.workspace,
      present: () => 'displayed proposal', ask: async () => ({ choice: 'decline' }),
    });
    assert.equal(declined.status, 'declined');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, 0);
    assert.equal(candidateRows(f.db).find(candidate => candidate.candidate_id === row.candidate_id)!.state, 'declined');
    // The same recorded evidence is never re-presented, even from a new turn.
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit', 'turn-2'));
    handleCodexHook(f.db, hookInput(f.root, 'Stop', 'turn-2'));
    const receipt = await considerPendingCaptureReservations(f.db, f.root);
    assert.equal(receipt.created, 0);
    assert.equal(candidateRows(f.db).filter(candidate => candidate.state === 'pending_review').length, 0);
  } finally { f.cleanup(); }
});

test('cancelled reservations never produce candidates', async () => {
  const f = fixture();
  try {
    recordedTrace(f.root);
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit'));
    handleCodexHook(f.db, hookInput(f.root, 'Stop'));
    handleCodexHook(f.db, hookInput(f.root, 'Interrupt'));
    assert.equal(reservations(f.db)[0]!.state, 'cancelled');
    const receipt = await considerPendingCaptureReservations(f.db, f.root);
    assert.equal(receipt.considered, 0);
    assert.equal(candidateRows(f.db).length, 0);
    assert.equal(reservations(f.db)[0]!.state, 'cancelled');
  } finally { f.cleanup(); }
});

test('approval saves the exact displayed revision and later recall finds it', async () => {
  const f = fixture();
  try {
    recordedTrace(f.root);
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit'));
    handleCodexHook(f.db, hookInput(f.root, 'Stop'));
    await considerPendingCaptureReservations(f.db, f.root);
    const row = candidateRows(f.db).find(candidate => candidate.state === 'pending_review')!;
    const proposal = JSON.parse(String(row.proposal_json));
    const approved = await reviewPendingCaptureCandidate(f.db, {
      candidateId: String(row.candidate_id), workspace: proposal.source.workspace,
      present: () => 'displayed proposal', ask: async () => ({ choice: 'approve' }),
    });
    assert.equal(approved.status, 'saved');
    assert.match(String(approved.approvalKey), /^[a-f0-9]{64}$/u);
    const receipt = f.db.prepare('SELECT workspace, digest FROM replay_memory_receipts WHERE approval_key=?')
      .get<{ workspace: string; digest: string }>(approved.approvalKey!)!;
    assert.equal(receipt.workspace, proposal.source.workspace);
    assert.equal(receipt.digest, row.digest);
    assert.equal(candidateRows(f.db).find(candidate => candidate.candidate_id === row.candidate_id)!.state, 'saved');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, 1);
    const context = await memoryContext(f.db, { cwd: f.root, query: 'npm test' });
    assert.equal(context.entries.length >= 1, true);
    assert.equal(context.entries[0]!.untrusted, true);
    // A replayed approval or save response never duplicates the memory.
    const replayed = await reviewPendingCaptureCandidate(f.db, {
      candidateId: String(row.candidate_id), workspace: proposal.source.workspace,
      present: () => 'displayed proposal', ask: async () => { throw new Error('approval must not be requested again'); },
    });
    assert.equal(replayed.status, 'saved');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM replay_memory_receipts').get<{ n: number }>()!.n, 1);
  } finally { f.cleanup(); }
});

test('a revised comment becomes a new version that requires fresh approval', async () => {
  const f = fixture();
  try {
    recordedTrace(f.root);
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit'));
    handleCodexHook(f.db, hookInput(f.root, 'Stop'));
    await considerPendingCaptureReservations(f.db, f.root);
    const row = candidateRows(f.db).find(candidate => candidate.state === 'pending_review')!;
    const proposal = JSON.parse(String(row.proposal_json));
    const displayed: string[] = [];
    let askCount = 0;
    const saved = await reviewPendingCaptureCandidate(f.db, {
      candidateId: String(row.candidate_id), workspace: proposal.source.workspace,
      present: value => { displayed.push(proposalDigest(value)); return 'displayed proposal'; },
      ask: async () => {
        askCount += 1;
        return askCount === 1 ? { choice: 'revise', comment: 'ユーザーの訂正: 報告前に各モジュールの型検査も行う。' } : { choice: 'approve' };
      },
    });
    assert.equal(saved.status, 'saved');
    assert.equal(askCount, 2);
    const finalRow = candidateRows(f.db).find(candidate => candidate.candidate_id === row.candidate_id)!;
    assert.equal(finalRow.revision, 2);
    const finalProposal = JSON.parse(String(finalRow.proposal_json));
    assert.equal(finalProposal.findings[0]!.basis, 'user_corrected');
    // The saved digest is exactly the last displayed body digest.
    const receipt = f.db.prepare('SELECT digest FROM replay_memory_receipts WHERE approval_key=?')
      .get<{ digest: string }>(saved.approvalKey!)!;
    assert.equal(receipt.digest, displayed.at(-1));
    assert.equal(receipt.digest, finalRow.digest);
  } finally { f.cleanup(); }
});

test('a completed memory run never reserves automatic consideration', async () => {
  const f = fixture();
  try {
    recordedTrace(f.root);
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit'));
    const prompt = handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit', 'turn-2')) as Record<string, unknown>;
    const requestId = /Kiokuko request (codex-[a-f0-9]+)/u.exec(String((prompt.hookSpecificOutput as Record<string, unknown>).additionalContext))![1]!;
    const prepared = await prepareAgentTask(f.db, { cwd: f.root, requestId, task: 'npm test を整備する', capabilities, skillDiscoveryMode: 'off',
      profileHints: { taskType: 'build', target: 'package.json', expected: 'npm test passes', constraints: '既存の変更を壊さない' } });
    handleCodexHook(f.db, { ...hookInput(f.root, 'PostToolUse', 'turn-2'), tool_name: 'mcp__kiokuko__task_prepare', tool_use_id: 'prepare',
      tool_input: { cwd: f.root, requestId }, tool_response: { structuredContent: prepared } });
    new LedgerStore(f.db).updateRunStatus(prepared.run.runId, 'completed');
    assert.deepEqual(handleCodexHook(f.db, hookInput(f.root, 'Stop', 'turn-2')), {});
    assert.equal(reservations(f.db).length, 0);
  } finally { f.cleanup(); }
});

test('the dedicated consideration command runs from the installed CLI without stdin', async () => {
  const f = fixture();
  try {
    recordedTrace(f.root);
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit'));
    handleCodexHook(f.db, hookInput(f.root, 'Stop'));
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'src/bin/kiokuko.ts', 'codex-hook',
      '--consider-candidates', '--database', f.databasePath, '--root', f.root], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(child.status, 0, child.stderr);
    const receipt = JSON.parse(child.stdout) as { created?: number };
    assert.equal(receipt.created, 1);
    assert.equal(reservations(f.db)[0]!.state, 'useful_candidates');
  } finally { f.cleanup(); }
});

test('reservation creation is reported once to the command layer for spawning consideration', () => {
  const f = fixture();
  try {
    recordedTrace(f.root);
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit'));
    const reported: Array<{ eventId: string; repositoryRoot: string }> = [];
    handleCodexHook(f.db, hookInput(f.root, 'Stop'), { onReservationCreated: info => reported.push(info) });
    assert.equal(reported.length, 1);
    assert.match(reported[0]!.eventId, /^codex-[a-f0-9]{64}$/u);
    assert.equal(reported[0]!.repositoryRoot, f.root);
    handleCodexHook(f.db, hookInput(f.root, 'Stop'), { onReservationCreated: info => reported.push(info) });
    assert.equal(reported.length, 1);
  } finally { f.cleanup(); }
});

test('historical and foreign-session traces cannot produce a current-turn candidate', async () => {
  const f = fixture();
  try {
    recordedTrace(f.root, 'run_abcdef', { turnId: 'old-turn' });
    recordedTrace(f.root, 'run_aaaaaa', { sessionId: 'other-chat' });
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit'));
    handleCodexHook(f.db, hookInput(f.root, 'Stop'));
    const receipt = await considerPendingCaptureReservations(f.db, f.root);
    assert.equal(receipt.created, 0);
    assert.equal(candidateRows(f.db).length, 0);
  } finally { f.cleanup(); }
});

test('an intact replay exceeding the aggregate blob budget is reported as a size limit', async () => {
  const f = fixture();
  try {
    const bytes = JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024 - 32) });
    const hash = createHash('sha256').update(bytes).digest('hex');
    const runId = 'run_abcdef';
    writeTrace(f.root, runId, Array.from({ length: 17 }, (_, index) =>
      line(index + 1, 'user.message', {}, { $blob: 'sha256:' + hash, bytes: Buffer.byteLength(bytes) })));
    const traceDirectory = path.join(f.root, '.agenticreplay', 'runs', runId);
    const blobs = path.join(traceDirectory, 'blobs', hash.slice(0, 2));
    mkdirSync(blobs, { recursive: true });
    writeFileSync(path.join(blobs, hash), bytes);
    await assert.rejects(extractReplayProposal({ cwd: f.root, traceDirectory,
      taskId: 'task', sessionId: 'session', workspace: 'project:test' }), /replay_blob_budget_exceeded/u);
  } finally { f.cleanup(); }
});

test('consideration waits for the current turn to finish and looks past a capped and an empty trace', async () => {
  const f = fixture({ runs: false });
  try {
    writeTranscript(f.root, 'turn-1', false);
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit'));
    handleCodexHook(f.db, hookInput(f.root, 'Stop'));
    const pending = considerPendingCaptureReservations(f.db, f.root);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(candidateRows(f.db).length, 0);
    assert.equal(reservations(f.db)[0]!.state, 'processing');
    const bytes = JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024 - 32) });
    const hash = createHash('sha256').update(bytes).digest('hex');
    const blob = { $blob: 'sha256:' + hash, bytes: Buffer.byteLength(bytes) };
    recordedTrace(f.root, 'run_abc001');
    recordedTrace(f.root, 'run_abc002', { empty: true });
    recordedTrace(f.root, 'run_abc003', { blobs: Array.from({ length: 17 }, () => blob) });
    const runs = path.join(f.root, '.agenticreplay', 'runs');
    const blobs = path.join(runs, desktopDirectoryName('run_abc003'), 'blobs', hash.slice(0, 2));
    mkdirSync(blobs, { recursive: true });
    writeFileSync(path.join(blobs, hash), bytes);
    for (const index of [1, 2, 3]) utimesSync(path.join(runs, desktopDirectoryName('run_abc00' + index)), index, index);
    const receipt = await pending;
    assert.equal(receipt.created, 1);
    assert.deepEqual(receipt.warnings, ['replay_blob_budget_exceeded']);
    assert.match(String(candidateRows(f.db)[0]!.evidence_key), /^run_abc001:/u);
  } finally { f.cleanup(); }
});

test('the native form can save a same-chat candidate, and cancellation leaves it pending', async () => {
  const f = fixture();
  const server = createKiokukoMcpServer({ databasePath: f.databasePath });
  const client = new Client({ name: 'desktop-fixture', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  try {
    recordedTrace(f.root);
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit'));
    handleCodexHook(f.db, hookInput(f.root, 'Stop'));
    assert.equal((await considerPendingCaptureReservations(f.db, f.root)).created, 1);
    const prompt = handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit', 'turn-2')) as { hookSpecificOutput: { additionalContext: string } };
    const args = JSON.parse(/with (\{[^\n]+?\})\. The app asks/u.exec(prompt.hookSpecificOutput.additionalContext)![1]!) as Record<string, unknown>;
    const name = 'memory_review_pending';
    const preHook = handleCodexHook(f.db, hookInput(f.root, 'PreToolUse', 'turn-2', {
      tool_name: 'mcp__kiokuko__memory_review_pending', tool_use_id: 'native-review', tool_input: args,
    }));
    assert.deepEqual(preHook, {});
    const messages: string[] = [];
    client.setRequestHandler(ElicitRequestSchema, async request => {
      assert.ok('requestedSchema' in request.params);
      messages.push(request.params.message);
      return messages.length === 1 ? { action: 'cancel' } : { action: 'accept', content: { choice: 'save' } };
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const unbound = await client.callTool({ name, arguments: { ...args, turnId: 'foreign-turn' } });
    assert.equal((unbound.structuredContent as { status?: string } | undefined)?.status, 'unavailable');
    const injection = await client.callTool({ name, arguments: { ...args, choice: 'save' } });
    assert.equal(injection.isError, true);
    assert.equal(messages.length, 0);
    const cancelled = await client.callTool({ name, arguments: args });
    assert.equal((cancelled.structuredContent as { status?: string } | undefined)?.status, 'unavailable');
    assert.equal(candidateRows(f.db)[0]!.state, 'pending_review');
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM entries').get<{ n: number }>()!.n, 0);
    const saved = await client.callTool({ name, arguments: args });
    assert.equal((saved.structuredContent as { status?: string } | undefined)?.status, 'saved');
    const row = candidateRows(f.db)[0]!;
    const proposal = JSON.parse(String(row.proposal_json));
    assert.equal(messages.length, 2);
    assert.equal(messages[0], messages[1]);
    assert.ok(messages[1]!.includes(proposal.request.text));
    for (const finding of proposal.findings) assert.ok(messages[1]!.includes(finding.text));
    assert.equal(row.state, 'saved');
    const context = await memoryContext(f.db, { cwd: f.root, query: 'npm test' });
    assert.equal(context.entries.length, 1);
    const repeated = await client.callTool({ name, arguments: args });
    assert.equal((repeated.structuredContent as { status?: string } | undefined)?.status, 'saved');
    assert.equal(messages.length, 2);
  } finally {
    await client.close();
    await server.close();
    f.cleanup();
  }
});
