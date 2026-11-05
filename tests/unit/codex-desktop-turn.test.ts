import assert from 'node:assert/strict';
import test from 'node:test';
import { completedDesktopTurn } from '../../src/assurance/codex-desktop-turn.js';

const sessionId = 'desktop-chat';
const turnId = 'desktop-turn';
const identity = { sessionId, turnId };
const session = { originator: 'codex_work_desktop', id: sessionId };
const event = (type: string, fields: Record<string, unknown>) => ({ type: 'event_msg', payload: { type, ...fields } });
const start = event('task_started', { turn_id: turnId, root_turn_id: turnId, started_at: 10 });
const complete = event('task_complete', { turn_id: turnId, root_turn_id: turnId, completed_at: 11 });

test('binds a completed root turn to the exact desktop chat and turn', () => {
  const unrelated = event('task_complete', { turn_id: 'another-turn', root_turn_id: 'another-turn', completed_at: 12 });
  assert.deepEqual(completedDesktopTurn(session, [start, complete, unrelated], identity), {
    sessionId, turnId, startedAt: 10, completedAt: 11,
  });
});

test('fails closed for partial, interrupted, duplicate, foreign and non-desktop events', () => {
  const abort = event('turn_aborted', { turn_id: turnId });
  for (const entries of [[start], [complete], [complete, start], [start, complete, complete], [start, abort, complete]]) {
    assert.equal(completedDesktopTurn(session, entries, identity), null);
  }
  assert.equal(completedDesktopTurn(session, [start, complete], { ...identity, turnId: 'other' }), null);
  assert.equal(completedDesktopTurn(session, [start, complete], { ...identity, sessionId: 'other' }), null);
  assert.equal(completedDesktopTurn({ ...session, originator: 'codex_cli_rs' }, [start, complete], identity), null);
  const child = event('task_complete', { turn_id: turnId, root_turn_id: 'parent-turn', completed_at: 11 });
  assert.equal(completedDesktopTurn(session, [start, child], identity), null);
});
