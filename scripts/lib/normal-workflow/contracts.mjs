// These are ordinary user requests. Tool names, selectors and TDD answers are
// discovered from unmodified installed instructions, never appended here.
export const SCENARIOS = [
  { id: 'LIVE-01', kind: 'inquiry', request: 'このリポジトリの送料計算は、いくらから無料になりますか。説明だけお願いします。' },
  { id: 'LIVE-02', kind: 'bug', request: '5,000円ちょうどでも送料がかかってしまいます。仕様どおりになるように修正してください。' },
  { id: 'LIVE-03', kind: 'feature', request: '会員は購入額にかかわらず送料無料にしてください。非会員の条件と既存呼び出しはそのままにしてください。' },
  { id: 'LIVE-04', kind: 'bug', fault: 'selector-once', request: '5,000円ちょうどでも送料がかかってしまいます。仕様どおりになるように修正してください。' },
  { id: 'LIVE-05-related', kind: 'feature', memory: 'related', request: '会員は購入額にかかわらず送料無料にしてください。非会員の条件と既存呼び出しはそのままにしてください。' },
  { id: 'LIVE-05-irrelevant', kind: 'inquiry', memory: 'irrelevant', request: 'このリポジトリの送料計算は、いくらから無料になりますか。説明だけお願いします。' },
  { id: 'LIVE-06-subdirectory', kind: 'bug', location: 'subdirectory', request: '5,000円ちょうどでも送料がかかってしまいます。仕様どおりになるように修正してください。' },
  { id: 'LIVE-06-outside', kind: 'conversation', location: 'outside', request: '送料が購入額5,000円以上なら無料、未満なら500円の場合、4,999円と5,000円の送料を説明してください。説明だけお願いします。' },
];
export const RESULT_CLASSES = ['PASS', 'FAIL_PRODUCT', 'FAIL_HARNESS', 'BLOCKED_ENV', 'BLOCKED_AUTH', 'NOT_RUN', 'NOT_APPLICABLE'];

export function approvalErrors(approval) {
  const errors = [];
  if (!approval || approval.approved !== true || approval.testCredentials !== true) errors.push('Explicit test-only approval required');
  if (approval?.provider !== 'chatgpt-subscription' || approval.maxCost !== 0 || approval.currency !== 'USD') errors.push('Paid spend control is unsupported by this adapter');
  if (typeof approval?.model !== 'string' || !approval.model.trim()) errors.push('Explicit model required');
  if (typeof approval?.clientVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/u.test(approval.clientVersion)) errors.push('Pinned client version required');
  if (!['low', 'medium', 'high', 'xhigh'].includes(approval?.reasoningEffort)) errors.push('Explicit reasoning effort required');
  if (typeof approval?.authFile !== 'string' || !approval.authFile.trim()) errors.push('Isolated test credentials required');
  if (!Array.isArray(approval?.clients) || !approval.clients.length || new Set(approval.clients).size !== approval.clients.length
    || approval.clients.some(client => !['codex-cli', 'codex-desktop'].includes(client))) errors.push('Explicit supported client targets required');
  if (approval?.attempts !== 1) errors.push('One attempt per scenario; automatic retries are unsupported');
  for (const [key, maximum] of [['maxSeconds', 600], ['maxTurns', 30], ['maxToolCalls', 120], ['maxTotalSeconds', 4800]])
    if (!Number.isSafeInteger(approval?.[key]) || approval[key] <= 0 || approval[key] > maximum) errors.push(`Invalid ${key}`);
  return errors;
}

/** All required results must describe the same immutable release candidate. */
export function releaseGate(candidate, reports, required) {
  const missing = [];
  if (!/^[a-f0-9]{40}$/u.test(candidate.commit ?? '') || !/^[a-f0-9]{64}$/u.test(candidate.artifactHash ?? '') || candidate.dirty !== false)
    missing.push('candidate must be a clean commit and a hashed artifact');
  for (const key of required) {
    const attempts = reports.filter(report => `${report.client}/${report.scenario}` === key);
    if (!attempts.length) { missing.push(`${key}: NOT_RUN`); continue; }
    // Keep all failures: a later success cannot erase an earlier failed attempt.
    for (const report of attempts) {
      if (report.classification !== 'PASS' || report.executionMode !== 'live'
        || report.commit !== candidate.commit || report.artifactHash !== candidate.artifactHash
        || report.instructionsVerified !== true || report.oraclePassed !== true)
        missing.push(`${key}: ${report.classification} or mismatched/unobserved evidence`);
    }
  }
  if (!required.length) missing.push('no required live scenarios');
  return { passed: missing.length === 0, missing };
}

export function releaseCandidateGate(candidate, deterministic, summaries) {
  const reasons = [];
  for (const gate of ['G0', 'G1', 'G2']) {
    const evidence = deterministic.filter(report => report.gate === gate);
    if (!evidence.length || evidence.some(report => report.classification !== 'PASS'
      || report.commit !== candidate.commit || report.artifactHash !== candidate.artifactHash
      || !Array.isArray(report.commands) || !report.commands.length
      || report.commands.some(command => command.exitCode !== 0))) reasons.push(`${gate}: missing, failed or mismatched deterministic evidence`);
  }
  if (!summaries.length) reasons.push('G3: no live summaries');
  const required = candidate.required;
  if (!Array.isArray(required) || !required.length) reasons.push('Explicit required client/scenario matrix is missing');
  const clients = candidate.clients;
  if (!Array.isArray(clients) || !clients.length || clients.some(client => !['codex-cli', 'codex-desktop'].includes(client))) reasons.push('Explicit client support matrix is missing');
  else {
    const expected = clients.flatMap(client => SCENARIOS.map(scenario => `${client}/${scenario.id}`)).sort();
    if (JSON.stringify([...(required ?? [])].sort()) !== JSON.stringify(expected)) reasons.push('Required scenarios were removed or substituted');
  }
  const live = releaseGate(candidate, summaries.flatMap(summary => summary.reports ?? []), Array.isArray(required) ? required : []);
  reasons.push(...live.missing);
  if (typeof candidate.configurationHash !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.configurationHash)
    || summaries.some(summary => summary.configurationHash !== candidate.configurationHash)) reasons.push('Model/limits/client configuration mismatch');
  return { releaseReady: reasons.length === 0, reasons };
}
