import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeReplayReviewMessage } from '../../src/mcp/replay-review.js';
import { fitsNativeReview } from '../../src/mcp/memory-capture-presentation.js';
import type { ReplayMemoryProposal } from '../../src/memory/replay-review.js';

function proposal(text: string): ReplayMemoryProposal {
 return { schemaVersion: 1, proposalId: 'private-proposal-id', revision: 7,
   source: { workspace: 'project:private-workspace', sessionId: 'private-session-id', taskId: 'private-task-id', turnId: 'private-turn-id',
     traces: [{ runId: 'run_abcdef', eventsSha256: 'a'.repeat(64), eventsRead: 10, totalEvents: 10, complete: false, gaps: [] }] },
   request: { text: 'Check the repository', evidenceRefs: ['run_abcdef:1'] }, languages: [],
   findings: [{ kind: 'key_point', text, basis: 'inferred', evidenceRefs: ['run_abcdef:6'] }],
   attempts: [{ attemptId: 'private-call-id', tool: 'exec', callRef: 'run_abcdef:2', resultRef: 'run_abcdef:5', outputExcerpt: 'private raw tool output',
     outcome: 'unknown', execution: 'unknown', payloadHashes: ['b'.repeat(64)], limitations: [] }],
   tags: ['agenticreplay'], keywords: ['private-keyword'],
 };
}

function checkCompact(message: string | undefined): asserts message is string {
 assert.ok(message);
 assert.match(message, /^今回の内容を記憶として保存しますか？\n\n/u);
 const summary = message.split('\n').slice(2);
 assert.ok(summary.length > 0 && summary.length <= 6, 'summary has at most six lines');
 for (const line of summary) {
   const width = Array.from(line).reduce((sum, c) => sum + (c.codePointAt(0)! > 0x7f ? 2 : 1), 0);
   assert.ok(width <= 72, 'each summary line fits the native dialog width');
 }
 assert.equal(fitsNativeReview(message), true);
 assert.doesNotMatch(message, /private-|run_abcdef|revision|SHA-256|payloadHashes|Search terms|Request excerpt|Tool result excerpt|Recorded final answer/u);
}

test('native review asks only about saving a readable summary and hides IDs embedded in key points', () => {
 const p = proposal('Recorded final answer (unverified): リポジトリ名はkiokukoです。 - 記録サービスへの接続を確認しました。 - Kiokuko runは c7b4a1ef-20f7-41e1-950b-2c83ea2ab7b0 - セッションID: private-session-id - 自動承認処理は queued');
 const original = structuredClone(p);
 const message = nativeReplayReviewMessage(p); checkCompact(message);
 assert.match(message, /リポジトリ名はkiokukoです。/u);
 assert.match(message, /記録サービスへの接続を確認しました。/u);
 assert.doesNotMatch(message, /c7b4a1ef|セッションID|Kiokuko run|queued|自動承認/u);
 assert.deepEqual(p, original, 'source evidence is preserved rather than rewritten for presentation');
});

test('long Japanese and English summaries fit six lines without exposing the evidence payload', () => {
 for (const text of [Array.from({ length: 50 }, (_, i) => `候補${i}は保存前に内容を判断できるようにします。`).join(''), Array.from({ length: 50 }, (_, i) => `Memory candidate ${i} should remain readable before saving it.`).join(' ')]) {
   const p = proposal(text); const original = structuredClone(p);
   const message = nativeReplayReviewMessage(p); checkCompact(message);
   assert.match(message, /…/u);
   assert.deepEqual(p, original);
 }
});

test('compact summary retains failure and uncertainty instead of implying verified success', () => {
 const p = proposal('ローカルの検証は成功しました。リモートCIは未確認です。接続エラーの原因はまだ分かりません。');
 p.source.taskOutcome = 'failed';
 const message = nativeReplayReviewMessage(p); checkCompact(message);
 assert.match(message, /作業は失敗しました。/u);
 assert.match(message, /リモートCIは未確認です。/u);
 assert.match(message, /原因はまだ分かりません。/u);
});

test('ordinary replay reviews use the same compact confirmation without desktop metadata', () => {
 const p = proposal('Keep migrations transactional.'); delete p.source.turnId;
 const message = nativeReplayReviewMessage(p); checkCompact(message);
 assert.match(message, /Keep migrations transactional/u);
});

test('missing key points fall back to meaningful request text while metadata-only proposals are not shown', () => {
 const p = proposal(''); p.findings = [];
 const message = nativeReplayReviewMessage(p); checkCompact(message);
 assert.match(message, /Check the repository/u);
 p.request.text = 'sessionId: private-session-id';
 assert.equal(nativeReplayReviewMessage(p), undefined);
});
