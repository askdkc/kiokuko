import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeReplayReviewMessage } from '../../src/mcp/replay-review.js';
import { fitsNativeReview } from '../../src/mcp/memory-capture-presentation.js';
import type { ReplayMemoryProposal } from '../../src/memory/replay-review.js';

test('desktop experience preview fits native approval without clipping the saved key points', () => {
 const keyPoint = 'Recorded final answer (unverified): ' + 'リポジトリはkiokukoです。'.repeat(14);
 const proposal: ReplayMemoryProposal = { schemaVersion: 1, proposalId: '', revision: 1,
   source: { workspace: 'repo', sessionId: 'session', taskId: 'task', turnId: 'turn', traces: [{ runId: 'run_abcdef', eventsSha256: 'a'.repeat(64), eventsRead: 10, totalEvents: 10, complete: false, gaps: ['one verified Codex desktop turn from AgenticReplay API traffic'] }] },
   request: { text: '記録と保存を確認してください。'.repeat(150), evidenceRefs: [] },
   languages: [], findings: [{ kind: 'key_point', text: keyPoint, basis: 'inferred', evidenceRefs: ['run_abcdef:6'] }],
   attempts: [{ attemptId: 'call', tool: 'exec', callRef: 'run_abcdef:2', resultRef: 'run_abcdef:5',
     outputExcerpt: 'maple-ledger '.repeat(160), outcome: 'unknown', execution: 'unknown', payloadHashes: [], limitations: [] }],
   tags: ['agenticreplay'], keywords: Array.from({ length: 64 }, (_, i) => 'keyword' + i),
 };
 const message = nativeReplayReviewMessage(proposal);
 assert.ok(message, 'source length must not suppress a valid bounded experience review');
 assert.equal(fitsNativeReview(message), true);
 assert.ok(message.includes(keyPoint), 'saved key points must remain complete in consent');
 assert.match(message, /Tool result excerpt/);
 assert.match(message, /maple-ledger/);
 assert.doesNotMatch(message, /keyword63|payloadHashes/);
 assert.equal(proposal.request.text.length > 2000, true, 'presentation must not mutate source evidence');
});
