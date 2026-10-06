import { createHash } from 'node:crypto';
import { approvalErrors, SCENARIOS } from './contracts.mjs';
import { RUBRIC_VERSION } from './answer-review.mjs';
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const policyHash = policy => createHash('sha256').update(JSON.stringify(canonical(policy))).digest('hex');
export function freezePolicy(approval, { testManifest, producer, reviewers }) {
  const errors = approvalErrors(approval);
  if (errors.length) throw new Error(errors.join('; '));
  if (!Array.isArray(testManifest) || !testManifest.length || new Set(testManifest.map(item => item.id)).size !== testManifest.length
    || testManifest.some(item => typeof item.id !== 'string' || !item.id || typeof item.optionalSkip !== 'boolean')) throw new Error('Independent reviewed test manifest required');
  if (!producer?.repository || !/^[a-f0-9]{40}$/u.test(producer.commit ?? '') || !producer.workflow || !producer.ref)
    throw new Error('Independent approved producer repository, immutable commit, workflow and ref required');
  if (!Array.isArray(reviewers) || !reviewers.length || reviewers.some(x => typeof x !== 'string' || !x.trim())) throw new Error('Approved independent reviewers required');
  const keys = ['provider','model','clientVersion','reasoningEffort','clients','attempts','maxSeconds','maxTotalSeconds','maxTurns','maxToolCalls','maxCost','currency'];
  const policy = canonical({ schema:'normal-workflow-policy-v1', ...Object.fromEntries(keys.map(key => [key, approval[key]])),
    scenarios:SCENARIOS, rubricVersion:RUBRIC_VERSION, testManifest, producer, reviewers });
  return { policy, hash:policyHash(policy) };
}
export function validatePolicy(policy, expectedHash) {
  if (!/^[a-f0-9]{64}$/u.test(expectedHash ?? '') || policyHash(policy) !== expectedHash) throw new Error('Policy differs from independently approved hash');
  const frozen = freezePolicy({ ...policy, approved:true, testCredentials:true, authFile:'not-retained' }, policy);
  if (policyHash(frozen.policy) !== expectedHash) throw new Error('Unsupported or substituted policy/scenarios/rubric');
  return policy;
}
export const requiredAttempts = policy => policy.clients.flatMap(client => policy.scenarios.map(scenario => `${client}/${scenario.id}`));
export function executionPolicyErrors(policy, actual, scenario, client) {
  const errors = [];
  for (const key of ['provider','model','clientVersion','reasoningEffort','maxSeconds','maxTurns','maxToolCalls','maxCost','currency'])
    if (actual?.[key] !== policy[key]) errors.push(`Execution differs from approved ${key}`);
  if (!policy.clients.includes(client) || actual?.request !== scenario.request || actual?.client !== client) errors.push('Client/request differs from policy');
  const argv = actual?.argv;
  if (!Array.isArray(argv) || argv.at(-1) !== scenario.request
    || argv.filter(value => value === `model=${JSON.stringify(policy.model)}`).length !== 1
    || argv.filter(value => value === `model_reasoning_effort=${JSON.stringify(policy.reasoningEffort)}`).length !== 1
    || argv.includes('--model') || argv.includes('-m')) errors.push('Actual client argv differs from frozen model/reasoning/request');
  if (actual?.modelObserved !== true || actual?.providerObserved !== true || actual?.clientVersionObserved !== true) errors.push('Actual model/provider/version identity is unobserved');
  if (!Number.isSafeInteger(actual?.calls) || actual.calls > policy.maxToolCalls || !Number.isSafeInteger(actual?.turns) || actual.turns > policy.maxTurns
    || !Number.isFinite(actual?.seconds) || actual.seconds < 0 || actual.seconds > policy.maxSeconds) errors.push('Resource usage missing or exceeded');
  return errors;
}
