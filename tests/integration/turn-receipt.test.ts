import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { turnReceiptSchema, validateUserTurnReceipt, verifyReceiptRecording, type TurnReceipt } from '../../src/agenticreplay/turn-receipt.js';
import { retainTurnReceipt } from '../../src/memory/turn-receipt-inbox.js';
import { extractTurnReceiptProposal } from '../../src/memory/replay-extract.js';
import { captureDiagnostics } from '../../src/memory/capture-diagnostics.js';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';

const expected = { source: 'chatgpt-host', sessionId: 'chat-a', turnId: 'turn-a', branchId: 'branch-a' } as const;
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kiokuko-receipt-')));
  const directory = path.join(root, '.agenticreplay', 'runs', 'run_abcdef');
  mkdirSync(directory, { recursive: true });
  // Synthetic bytes exercise the integrity boundary, not a ChatGPT adapter.
  const bytes = '{}\n';
  const receipt: TurnReceipt = { schemaVersion: 1, receiptId: 'a'.repeat(64), ...expected,
    scope: 'user', requestIds: ['request-a'], identityComplete: true, outcome: 'completed',
    evidence: 'host-notification', capture: 'complete', recording: { runId: 'run_abcdef', directory,
      eventsSha256: createHash('sha256').update(bytes).digest('hex') } };
  writeFileSync(path.join(directory, 'events.jsonl'), bytes);
  writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ run_id: receipt.recording.runId, cwd: root,
    capture: { status: 'complete' }, integrity: { events_sha256: receipt.recording.eventsSha256 } }));
  const database = path.join(root, 'test.sqlite3');
  const db = openConnection(database); migrateDatabase(db);
  return { root, directory, receipt, database, db, close() { try { db.close(); } catch {} rmSync(root, { recursive: true, force: true }); } };
}

test('shared receipt schema rejects extra fields, malformed identities and incomplete identity claims', () => {
  const f = fixture();
  try {
    assert.equal(turnReceiptSchema.safeParse(f.receipt).success, true);
    for (const patch of [{ schemaVersion: 2 }, { approved: true }, { requestIds: ['a', 'a'] },
      { requestIds: [] }, { branchId: null }, { scope: 'unknown' }, { sessionId: '../escape' },
      { evidence: 'model-end-turn' }, { recording: { ...f.receipt.recording, signature: 'invented' } }]) {
      assert.equal(turnReceiptSchema.safeParse({ ...f.receipt, ...patch }).success, false, JSON.stringify(patch));
    }
  } finally { f.close(); }
});

test('shared eligibility rejects foreign source/chat/turn/branch, background, child, incomplete and noncompleted records', () => {
  const f = fixture();
  try {
    assert.deepEqual(validateUserTurnReceipt(f.receipt, expected), f.receipt);
    for (const patch of [{ source: 'codex-runtime' }, { sessionId: 'other' }, { turnId: 'other' }, { branchId: 'other' },
      { scope: 'background' }, { scope: 'subagent' }, { identityComplete: false },
      { scope: 'unknown', identityComplete: false, branchId: null }, { capture: 'incomplete' },
      { outcome: 'interrupted' }, { outcome: 'failed' }]) {
      assert.throws(() => validateUserTurnReceipt({ ...f.receipt, ...patch }, expected), /^Error: receipt_/u);
    }
  } finally { f.close(); }
});

test('a well-formed receipt does not invent a ChatGPT adapter or replace Codex transcript evidence', async () => {
  const f = fixture();
  try {
    assert.equal(await verifyReceiptRecording(f.root, f.receipt), f.directory);
    await assert.rejects(extractTurnReceiptProposal({ cwd: f.root, receipt: f.receipt, expected }), /chatgpt_adapter_unsupported/u);
    await assert.rejects(extractTurnReceiptProposal({ cwd: f.root, receipt: { ...f.receipt, source: 'codex-runtime' },
      expected: { ...expected, source: 'codex-runtime' } }), /codex_transcript_required/u);
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM entries').get()!.n, 0);
  } finally { f.close(); }
});

test('recording digest, manifest identity, missing files and escaped paths are independently rejected', async () => {
  const f = fixture();
  try {
    await assert.rejects(verifyReceiptRecording(f.root, { ...f.receipt, recording: { ...f.receipt.recording, eventsSha256: 'b'.repeat(64) } }), /receipt_recording_integrity/u);
    await assert.rejects(verifyReceiptRecording(f.root, { ...f.receipt, recording: { ...f.receipt.recording, runId: 'run_aaaaaa' } }), /receipt_recording_integrity/u);
    await assert.rejects(verifyReceiptRecording(f.root, { ...f.receipt, recording: { ...f.receipt.recording, directory: f.root } }), /receipt_recording_scope/u);
    rmSync(path.join(f.directory, 'events.jsonl'));
    await assert.rejects(verifyReceiptRecording(f.root, f.receipt), { code: 'ENOENT' });
    writeFileSync(path.join(f.root, 'outside.jsonl'), '{}\n');
    symlinkSync(path.join(f.root, 'outside.jsonl'), path.join(f.directory, 'events.jsonl'));
    await assert.rejects(verifyReceiptRecording(f.root, f.receipt), /receipt_recording_scope/u);
  } finally { f.close(); }
});

test('durable receipt deduplication survives reopen and rejects a changed body or workspace', () => {
  const f = fixture();
  try {
    assert.equal(retainTurnReceipt(f.db, f.root, f.receipt, expected), 'receipt_verified_identity');
    f.db.close();
    const reopened = openConnection(f.database);
    try {
      retainTurnReceipt(reopened, f.root, f.receipt, expected);
      assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM memory_capture_receipts').get()!.n, 1);
      assert.throws(() => retainTurnReceipt(reopened, f.root, { ...f.receipt, outcome: 'failed' }, expected), /receipt_conflict/u);
      assert.throws(() => retainTurnReceipt(reopened, f.root + '/other', f.receipt, expected), /receipt_conflict/u);
      assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM memory_capture_candidates').get()!.n, 0);
      assert.equal(captureDiagnostics(reopened, f.root).notification, 'hook_not_observed');
    } finally { reopened.close(); }
    assert.equal(captureDiagnostics(f.db, f.root).reason, 'capture_diagnostics_unavailable');
  } finally { f.close(); }
});

test('private recorder socket reads the shared receipt without sending completion and rejects malformed replies', async t => {
  const { createServer } = await import('node:net');
  const { chmodSync } = await import('node:fs');
  const { readRecorderTurnReceipt } = await import('../../src/agenticreplay/codex-replay.js');
  const f = fixture();
  const socket = path.join(f.root, 'receipt.sock');
  const requests: unknown[] = [];
  let reply: unknown = { status: 'finalized', receipt: f.receipt };
  const server = createServer(connection => {
    let bytes = '';
    connection.on('data', chunk => {
      bytes += String(chunk);
      if (bytes.includes('\n')) { requests.push(JSON.parse(bytes)); connection.end(JSON.stringify(reply)); }
    });
  });
  try {
    chmodSync(f.root, 0o700);
    try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Sandbox denies Unix socket listen; real transport remains unverified'); return; }
      throw error;
    }
    chmodSync(socket, 0o600);
    const binding = { sessionId: expected.sessionId, turnId: expected.turnId };
    assert.deepEqual(await readRecorderTurnReceipt(socket, f.root, binding, AbortSignal.timeout(2000)), f.receipt);
    assert.deepEqual(requests, [{ action: 'receipt', cwd: f.root, ...binding }]);
    reply = { status: 'unavailable' };
    assert.equal(await readRecorderTurnReceipt(socket, f.root, binding, AbortSignal.timeout(2000)), undefined);
    reply = { status: 'finalized', receipt: { ...f.receipt, evidence: 'model-text' } };
    await assert.rejects(readRecorderTurnReceipt(socket, f.root, binding, AbortSignal.timeout(2000)), /receipt_schema_invalid/u);
    reply = { status: 'finalized', receipt: f.receipt };
    chmodSync(socket, 0o666);
    await assert.rejects(readRecorderTurnReceipt(socket, f.root, binding, AbortSignal.timeout(2000)), /receipt_transport_untrusted/u);
  } finally { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); f.close(); }
});
