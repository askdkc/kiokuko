import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { handleCodexHook } from '../../src/assurance/codex-hooks.js';
import { considerPendingCaptureReservations } from '../../src/memory/capture-consideration.js';
import { reviewPendingCaptureCandidate } from '../../src/memory/capture-pending-review.js';
import { memoryContext } from '../../src/memory/observations.js';
import { proposalDigest } from '../../src/memory/replay-review.js';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';
import { LedgerStore } from '../../src/ledger/store.js';

interface Fixture { base: string; root: string; databasePath: string; db: ReturnType<typeof openConnection>; cleanup(): void; }
function fixture(options: { runs?: boolean } = {}): Fixture {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'kiokuko-capture-')));
  execFileSync('git', ['init', '-q', base]);
  const databasePath = path.join(base, 'memory.sqlite3');
  const db = openConnection(databasePath);
  migrateDatabase(db);
  if (options.runs !== false) mkdirSync(path.join(base, '.agenticreplay', 'runs'), { recursive: true });
  return { base, root: base, databasePath, db, cleanup() { try { db.close(); } catch { /* already closed */ } rmSync(base, { recursive: true, force: true }); } };
}
const line = (seq: number, type: string, attrs: Record<string, unknown>, payload?: unknown, causes?: number[]) => ({
  seq, ts: '2026-11-07T00:00:00Z', mono_us: seq, turn: 1, type, actor: 'tool', attrs, ...(payload === undefined ? {} : { payload }), ...(causes === undefined ? {} : { causes }),
});
function writeTrace(root: string, runId: string, events: unknown[], options: { corrupt?: boolean } = {}): void {
  const directory = path.join(root, '.agenticreplay', 'runs', runId);
  mkdirSync(directory, { recursive: true });
  let bytes = events.map(line => JSON.stringify(line)).join('\n') + '\n';
  if (options.corrupt) bytes += '{}\n';
  writeFileSync(path.join(directory, 'events.jsonl'), bytes);
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({
    schema_version: '0.4.0', run_id: runId, cwd: root,
    integrity: { events_sha256: createHash('sha256').update(bytes).digest('hex') },
  }));
}
const recordedTrace = (root: string, runId = 'run_abcdef') => writeTrace(root, runId, [
  line(1, 'user.message', {}, { text: '毎回 npm test を先に走らせてから報告して。' }),
  line(2, 'shell.call', { name: 'shell', tool_use_id: 'call-1' }, { arguments: { command: 'npm test' } }),
  line(3, 'shell.result', { exit_code: 0, tool_use_id: 'call-1' }, { stdout: 'all tests passed' }, [2]),
]);
const hookInput = (root: string, hook_event_name: string, turn_id = 'turn-1', extra: Record<string, unknown> = {}) =>
  ({ hook_event_name, session_id: 'session-a', turn_id, cwd: root, ...extra });
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
    handleCodexHook(f.db, hookInput(f.root, 'Stop'));
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

test('Stop notifies exactly once per pending candidate and never for empty results', async () => {
  const f = fixture();
  try {
    recordedTrace(f.root);
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit'));
    handleCodexHook(f.db, hookInput(f.root, 'Stop'));
    await considerPendingCaptureReservations(f.db, f.root);
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit', 'turn-2'));
    const notified = handleCodexHook(f.db, hookInput(f.root, 'Stop', 'turn-2')) as Record<string, unknown>;
    assert.match(String(notified.systemMessage), /memory candidates|memory-review/u);
    assert.doesNotMatch(String(notified.systemMessage), /npm test を先に/u); // Candidate bodies never enter hook output.
    // The same candidates are never announced twice.
    handleCodexHook(f.db, hookInput(f.root, 'UserPromptSubmit', 'turn-3'));
    assert.deepEqual(handleCodexHook(f.db, hookInput(f.root, 'Stop', 'turn-3')), {});
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
