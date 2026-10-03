import test from 'node:test';
import assert from 'node:assert/strict';
import { PollDiagnostics } from '../../src/chatgpt/poll-diagnostics.js';
import { BoundedLogStream } from '../../src/chatgpt/log-stream.js';
function failed(d: PollDiagnostics, time: number, extra: object = {}) {
  return d.line(JSON.stringify({ component: 'controlplane', level: 'WARN', msg: 'poll failed; backing off', error: 'read: connection reset by peer', retry_in_ms: 200, ...extra }), time);
}
test('health degrades immediately, third failure warns and warning aggregates until recovery', () => {
  const d = new PollDiagnostics();
  assert.equal(failed(d, 1000)?.level, 'DEBUG'); assert.equal(d.state, 'degraded');
  assert.equal(failed(d, 2000)?.level, 'DEBUG'); assert.equal(failed(d, 3000)?.level, 'WARN');
  assert.equal(failed(d, 62000)?.level, 'DEBUG'); assert.equal(failed(d, 63000)?.level, 'WARN');
  assert.equal(d.success(64000)?.level, 'INFO'); assert.equal(d.success(65000), undefined);
  assert.equal(d.failures, 0); assert.equal(d.state, 'operational');
});
test('brief interruptions recover quietly; older metrics cannot clear a later failure', () => {
  const d = new PollDiagnostics(); failed(d, 5000); d.metrics(4); assert.equal(d.state, 'degraded');
  assert.equal(d.metrics(6)?.level, 'DEBUG'); assert.equal(d.state, 'operational');
});
test('actionable and unknown failures report immediately with bounded credential-free output', () => {
  for (const extra of [{ status_code: 401 }, { error: 'x509: invalid certificate' }, { error: 'invalid character in JSON' }, { error: 'unknown key sk-secret' }]) {
    const d = new PollDiagnostics(); assert.equal(failed(d, 1000, extra)?.level, 'WARN');
    assert.equal(failed(d, 2000, extra)?.level, 'DEBUG'); assert.ok(!JSON.stringify(d.events).includes('sk-secret'));
  }
});
test('shutdown suppresses alarms and malformed lines stay visible', () => {
  const d = new PollDiagnostics(); assert.equal(d.line('bad', 1000)?.kind, 'diagnostics_unavailable');
  d.state = 'stopped'; assert.equal(failed(d, 2000), undefined); assert.equal(d.success(3000), undefined);
});
test('bounded line parser handles chunking, utf8 and oversized unterminated lines then resumes', () => {
  const lines: string[] = []; let lost = 0;
  const parser = new BoundedLogStream(s => lines.push(s), () => lost++);
  parser.push(Buffer.from('{"a":')); parser.push(Buffer.from('"日"}\n'));
  parser.push(Buffer.alloc(70000, 120)); parser.push(Buffer.from('\nok\n'));
  assert.deepEqual(lines, ['{"a":"日"}', 'ok']); assert.equal(lost, 1);
});
test('diagnostic history never exceeds 200 observations', () => {
  const d = new PollDiagnostics(); for (let i = 0; i < 1000; i++) failed(d, i); assert.equal(d.events.length, 200);
});

test('distinct actionable failures are each visible while identical failures aggregate', () => {
  const d = new PollDiagnostics();
  assert.equal(failed(d, 1000, { error: 'unrecognized A' })?.level, 'WARN');
  assert.equal(failed(d, 2000, { error: 'unrecognized B' })?.level, 'WARN');
  assert.equal(failed(d, 3000, { error: 'unrecognized B' })?.level, 'DEBUG');
});

test('wall clock changes do not defeat the monotonic warning interval', () => {
  const d = new PollDiagnostics();
  const line = (time: string) => JSON.stringify({component:'controlplane',level:'WARN',msg:'poll failed; backing off',error:'read: connection reset by peer',time});
  d.line(line('2026-10-03T10:00:00Z'), 1000, 1000); d.line(line('2026-10-03T10:00:01Z'), 2000, 2000);
  assert.equal(d.line(line('2026-10-03T10:00:02Z'), 3000, 3000)?.level, 'WARN');
  assert.equal(d.line(line('2026-10-03T09:00:00Z'), 4000, 4000)?.level, 'DEBUG');
});
