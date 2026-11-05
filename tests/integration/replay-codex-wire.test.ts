import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractReplayProposal } from '../../src/memory/replay-extract.js';
import { nativeReplayReviewMessage } from '../../src/mcp/replay-review.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const tool = { type: 'custom_tool_call', name: 'exec', call_id: 'current-call', input: 'text(await tools.exec_command({cmd:"git rev-parse --show-toplevel"}));' };
const final = { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Repository is maple-ledger. Verified result: cedar-result-marker.' }] };
function fixture(t: { after: (fn: () => void) => void }, responses: unknown[][] = [[tool], [final]], outputs: unknown[] = [
  { type: 'custom_tool_call_output', call_id: 'history-call', output: 'HISTORICAL-RESULT' },
  { type: 'custom_tool_call_output', call_id: 'current-call', output: [{ type: 'input_text', text: 'Process exited with code 0\nmaple-ledger cedar-result-marker' }] },
]) {
 const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'replay-codex-wire-')));
 t.after(() => rmSync(root, { recursive: true, force: true }));
 const dir = path.join(root, '.agenticreplay', 'runs', 'run_abcdef'); mkdirSync(dir, { recursive: true });
 const events: Record<string, unknown>[] = [{ seq: 0, type: 'run.start', attrs: { source: 'codex-desktop-api', sessionId: 'session', turnId: 'turn' } }];
 const responsePayload = (output: unknown[]) => 'data: ' + JSON.stringify({ type: 'response.output_item.done', item: tool }) + '\n\n'
   + 'data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'response', status: 'completed', output: [
     { type: 'reasoning', summary: [{ type: 'summary_text', text: 'PRIVATE-REASONING' }] }, ...output,
   ] } }) + '\n\n';
 responses.forEach((output, index) => {
   const request_id = `request-${index}`;
   events.push({ seq: events.length, type: 'model.request', attrs: { request_id }, payload: JSON.stringify({ instructions: 'PRIVATE-SYSTEM', input: [
     { role: 'user', content: [{ type: 'input_text', text: 'HISTORICAL-REQUEST' }] },
     { role: 'user', content: [{ type: 'input_text', text: 'Check repository' }] },
     ...(index ? outputs : [{ type: 'custom_tool_call_output', call_id: 'history-call', output: 'HISTORICAL-RESULT' }]),
   ] }) });
   const data = JSON.stringify(responsePayload(output)), digest = hash(data);
   mkdirSync(path.join(dir, 'blobs', digest.slice(0, 2)), { recursive: true });
   writeFileSync(path.join(dir, 'blobs', digest.slice(0, 2), digest), data);
   events.push({ seq: events.length, type: 'model.response', attrs: { request_id }, payload: { $blob: `sha256:${digest}`, bytes: Buffer.byteLength(data) } });
   const seq = events.length;
   events.push({ seq, type: 'net.request', attrs: { request_id, headers: { 'x-codex-turn-metadata': JSON.stringify({ thread_id: 'session', turn_id: 'turn' }) } } });
   events.push({ seq: events.length, type: 'net.response', causes: [seq], attrs: { request_id, response_complete: true, capture_incomplete: false } });
 });
 events.push({ seq: events.length, type: 'run.end' });
 const write = () => {
   const bytes = events.map(e => JSON.stringify(e)).join('\n') + '\n';
   writeFileSync(path.join(dir, 'events.jsonl'), bytes);
   writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schema_version: '0.4.0', run_id: 'run_abcdef', cwd: root,
     adapter: { id: 'codex-desktop-api' }, capture: { status: 'complete' }, integrity: { events_sha256: hash(bytes) } }));
 };
 write();
 return { events, write, input: { cwd: root, traceDirectory: dir, taskId: 'task', sessionId: 'session', workspace: 'repo', desktopTurnId: 'turn', desktopUserTextDigests: [hash('Check repository')] } };
}

test('sealed desktop API blobs yield current-turn calls, results and public final key points', async t => {
 const f = fixture(t); const p = await extractReplayProposal(f.input);
 assert.equal(p.request.text, 'Check repository');
 assert.equal(p.attempts.length, 1);
 assert.equal(p.attempts[0]?.tool, 'exec');
 assert.match(String(p.attempts[0]?.arguments), /git rev-parse/);
 assert.equal(p.attempts[0]?.callRef, 'run_abcdef:2');
 assert.equal(p.attempts[0]?.resultRef, 'run_abcdef:5');
 assert.match(p.attempts[0]?.outputExcerpt ?? '', /maple-ledger cedar-result-marker/);
 assert.equal(p.attempts[0]?.outcome, 'unknown', 'text mentioning exit 0 is not structured process status');
 assert.equal(p.findings[0]?.basis, 'inferred');
 assert.match(p.findings[0]?.text ?? '', /Repository is maple-ledger/);
 assert.deepEqual(p.findings[0]?.evidenceRefs, ['run_abcdef:6']);
 assert.ok(p.keywords.includes('cedar-result-marker'));
 assert.doesNotMatch(JSON.stringify(p), /PRIVATE-|HISTORICAL-/);
});

test('repeated historical echoes do not duplicate a current-turn tool result', async t => {
 const f = fixture(t, [[tool], [], [final]]); const p = await extractReplayProposal(f.input);
 assert.equal(p.attempts.length, 1); assert.equal(p.attempts[0]?.resultRef, 'run_abcdef:5');
});

test('conflicting result echoes remain ambiguous instead of selecting a convenient result', async t => {
 const f = fixture(t, [[tool], [final]], [
   { type: 'custom_tool_call_output', call_id: 'current-call', output: 'first' },
   { type: 'custom_tool_call_output', call_id: 'current-call', output: 'different' },
 ]); const p = await extractReplayProposal(f.input);
 assert.equal(p.attempts.length, 1); assert.equal(p.attempts[0]?.resultRef, undefined);
 assert.ok(p.attempts[0]?.limitations.includes('ambiguous results'));
});

test('response request identity must be bound to the verified desktop turn', async t => {
 const f = fixture(t); f.events[2]!.attrs = { request_id: 'foreign' }; f.write();
 await assert.rejects(extractReplayProposal(f.input), /replay_desktop_response_mismatch/);
});

test('redacts full secret-bearing arguments, result and final fields before excerpts', async t => {
 const secret = '\npassword=abcdefghijklmnop';
 const f = fixture(t, [[{ ...tool, input: 'x'.repeat(3000) + secret }], [{ ...final, content: [{ type: 'output_text', text: 'x'.repeat(3000) + secret }] }]], [
   { type: 'custom_tool_call_output', call_id: 'current-call', output: 'x'.repeat(3000) + secret },
 ]); const p = await extractReplayProposal(f.input);
 assert.equal(p.attempts.length, 1); assert.match(String(p.attempts[0]?.arguments), /redacted/);
 assert.match(p.attempts[0]?.outputExcerpt ?? '', /redacted/);
 assert.doesNotMatch(JSON.stringify(p), /abcdefghijklmnop/);
});

test('results predating a same-ID call are not attributed to that call', async t => {
 const f = fixture(t, [[{ ...tool, call_id: 'history-call' }], [final]], []);
 const p = await extractReplayProposal(f.input);
 assert.equal(p.attempts.length, 1); assert.equal(p.attempts[0]?.resultRef, undefined);
 assert.ok(p.attempts[0]?.limitations.includes('result missing'));
});

test('a response may not claim a missing request and a captured request may not lose its response', async t => {
 const f = fixture(t); f.events.splice(6, 1); f.write();
 await assert.rejects(extractReplayProposal(f.input), /replay_desktop_response_mismatch/);
});

test('conflicting repeated call IDs fail closed', async t => {
 const f = fixture(t, [[tool], [{ ...tool, input: 'different command' }, final]]);
 await assert.rejects(extractReplayProposal(f.input), /replay_desktop_call_ambiguous/);
});

test('missing public final answer uses a bounded recorded result without inventing task success', async t => {
 const f = fixture(t, [[tool], []]); const p = await extractReplayProposal(f.input);
 assert.equal(p.findings[0]?.basis, 'observed');
 assert.match(p.findings[0]?.text ?? '', /task success unverified/);
 assert.match(p.findings[0]?.text ?? '', /cedar-result-marker/);
 assert.doesNotMatch(JSON.stringify(p), /PRIVATE-|HISTORICAL-/);
});

test('malformed sealed SSE does not yield a partial proposal', async t => {
 const f = fixture(t); f.events[2]!.payload = 'data: {invalid}\n\n'; f.write();
 await assert.rejects(extractReplayProposal(f.input));
});


test('long multiline final answers retain bounded key points and an operable native preview', async t => {
 const f = fixture(t, [[tool], [{ ...final, content: [{ type: 'output_text', text: 'Verified repository maple-ledger.\n'.repeat(100) }] }]]);
 const p = await extractReplayProposal(f.input);
 assert.ok(p.findings[0]!.text.length < 300);
 assert.match(p.findings[0]!.text, /excerpt/);
 assert.ok(nativeReplayReviewMessage(p));
});
