// Ordinary user requests never include Skill selectors, TDD answers or grading
// hints. The separate environment contract describes only controller capabilities.
export const FIXTURE_ENVIRONMENT_INSTRUCTIONS =
  'The native shell and apply_patch sandbox is read-only. The independent fixture_executor MCP server provides bounded write access to the synthetic repository through its declared tools. '+
  'Use that controller for requested repository edits and supported test execution; it persists an immutable tree-bound checkpoint before sending each command response. '+
  'Native tests or in-memory proposals do not persist repository changes or command-bound receipts. This does not grant native writes, escalation, network access or access to other paths.';
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
export const RESULT_CLASSES = ['PASS', 'FAIL_PRODUCT', 'FAIL_HARNESS', 'BLOCKED_ENV', 'BLOCKED_AUTH', 'NOT_RUN', 'NOT_APPLICABLE', 'WAITING_REVIEW'];

export function approvalErrors(approval) {
  const errors = [];
  if (!approval || approval.approved !== true || approval.testCredentials !== true) errors.push('Explicit test-only approval required');
  if (approval?.provider !== 'chatgpt-subscription' || approval.maxCost !== 0 || approval.currency !== 'USD') errors.push('Paid spend control is unsupported by this adapter');
  if (typeof approval?.model !== 'string' || !approval.model.trim()) errors.push('Explicit model required');
  if (typeof approval?.clientVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?$/u.test(approval.clientVersion)) errors.push('Pinned client version required');
  if (!['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(approval?.reasoningEffort)) errors.push('Explicit reasoning effort required');
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
    if (attempts.length !== 1) {  missing.push(`${key}: NOT_RUN`); continue; }
    // Keep all failures: a later success cannot erase an earlier failed attempt.
    for (const report of attempts) {
      if (report.classification !== 'PASS' || report.executionMode !== 'live'
        || report.commit !== candidate.commit || report.artifactHash !== candidate.artifactHash
        || report.instructionsVerified !== true || report.oraclePassed !== true)
        missing.push(`${key}: ${report.classification} or mismatched/unobserved evidence`);
    }
  }
  if (reports.some(report => !required.includes(`${report.client}/${report.scenario}`))) missing.push('unexpected attempts');
  if (!required.length) missing.push('no required live scenarios');
  return { passed: missing.length === 0, missing };
}

/** Legacy summaries are diagnostic only. G4 requires verifyEvidenceBundle. */
export function releaseCandidateGate(candidate, deterministic, summaries) {
  return { releaseReady:false, reasons:['Summary-only evidence is not release authority: actual artifact, frozen policy and authenticated raw producer evidence required'] };
}
