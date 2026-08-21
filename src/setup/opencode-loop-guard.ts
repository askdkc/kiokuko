import { KiokukoError } from '../errors.js';
import type { DelimitedBlockResult } from './managed-text.js';
import { OPENCODE_CAPTURE_PROFILES, OPENCODE_MODES, type OpenCodeCaptureProfile, type OpenCodeMode } from './opencode-evidence.js';

export const OPENCODE_LOOP_GUARD_MARKER = '// Managed by `kiokuko setup`: OpenCode loop guard v1';

const LOOP_GUARD_SOURCE = `${OPENCODE_LOOP_GUARD_MARKER}
const MAX_AGENT_STEPS = 12
const MAX_CONSECUTIVE_REPEATS = 3
const BUILTIN_AGENTS = ['build', 'plan', 'general', 'explore', 'scout']
const HIDDEN_AGENTS = new Set(['compaction', 'title', 'summary'])
const READ_ONLY_DISCOVERY_TOOLS = new Set(['read', 'grep', 'glob', 'find', 'search', 'webfetch', 'websearch', 'memory_recall', 'curator_check'])

function freshTurn(messageID) {
  return {
    messageID,
    taskPrepareStarted: false,
    taskPrepareCompleted: false,
    curatorCheckStarted: false,
    checkpointStarted: false,
    checkpointCompleted: false,
    lastCallFingerprint: undefined,
    repeatedCallCount: 0,
    lastResultFingerprint: undefined,
    repeatedResultCount: 0,
    blockedReason: undefined,
  }
}

function canonical(value, ancestors = new WeakSet()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value))
  if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') return JSON.stringify(String(value))
  if (value === undefined) return '"[undefined]"'
  if (ancestors.has(value)) return '"[circular]"'
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return '[' + value.map((item) => canonical(item, ancestors)).join(',') + ']'
    const entries = Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key], ancestors))
    return '{' + entries.join(',') + '}'
  } catch {
    return JSON.stringify(Object.prototype.toString.call(value))
  } finally {
    ancestors.delete(value)
  }
}

async function fingerprint(value) {
  const bytes = new TextEncoder().encode(canonical(value))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function lifecycleTool(tool) {
  const normalized = tool.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (normalized === 'kiokuko_task_prepare' || normalized.endsWith('_kiokuko_task_prepare')) return 'task_prepare'
  if (normalized === 'kiokuko_curator_check' || normalized.endsWith('_kiokuko_curator_check')) return 'curator_check'
  if (normalized === 'kiokuko_memory_checkpoint' || normalized.endsWith('_kiokuko_memory_checkpoint')) return 'memory_checkpoint'
  return undefined
}

function isReadOnlyDiscoveryTool(tool) {
  const normalized = tool.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  if (READ_ONLY_DISCOVERY_TOOLS.has(normalized)) return true
  return [...READ_ONLY_DISCOVERY_TOOLS].some((name) => normalized.endsWith('_' + name))
}

function capAgentSteps(config) {
  if (!config.agent || typeof config.agent !== 'object' || Array.isArray(config.agent)) config.agent = {}
  for (const name of BUILTIN_AGENTS) {
    if (!config.agent[name] || typeof config.agent[name] !== 'object' || Array.isArray(config.agent[name])) config.agent[name] = {}
  }
  for (const [name, agent] of Object.entries(config.agent)) {
    if (HIDDEN_AGENTS.has(name) || !agent || typeof agent !== 'object' || Array.isArray(agent) || agent.hidden === true) continue
    if (!Number.isInteger(agent.steps) || agent.steps < 1 || agent.steps > MAX_AGENT_STEPS) agent.steps = MAX_AGENT_STEPS
  }
}

function sessionIDFromEvent(event) {
  const properties = event && typeof event === 'object' ? event.properties : undefined
  if (!properties || typeof properties !== 'object') return undefined
  if (typeof properties.sessionID === 'string') return properties.sessionID
  if (properties.info && typeof properties.info === 'object' && typeof properties.info.id === 'string') return properties.info.id
  return undefined
}

function toolSucceeded(output) {
  if (!output || typeof output !== 'object') return true
  if (output.isError === true || output.error !== undefined || output.status === 'error') return false
  if (output.result && typeof output.result === 'object' && (output.result.isError === true || output.result.error !== undefined)) return false
  return true
}

export const KiokukoLoopGuard = async () => {
  const sessions = new Map()
  const stateFor = (sessionID) => {
    const existing = sessions.get(sessionID)
    if (existing) return existing
    const created = freshTurn(undefined)
    sessions.set(sessionID, created)
    return created
  }

  return {
    config: async (config) => {
      capAgentSteps(config)
    },
    'chat.message': async (input) => {
      sessions.set(input.sessionID, freshTurn(input.messageID))
    },
    event: async ({ event }) => {
      if (!['session.idle', 'session.deleted'].includes(event.type)) return
      const sessionID = sessionIDFromEvent(event)
      if (sessionID) sessions.delete(sessionID)
    },
    'tool.execute.before': async (input, output) => {
      const state = stateFor(input.sessionID)
      if (state.blockedReason) throw new Error(state.blockedReason)

      const lifecycle = lifecycleTool(input.tool)
      if (lifecycle === 'task_prepare') {
        if (state.taskPrepareStarted) {
          throw new Error('Kiokuko loop guard: task_prepare is limited to once per user request. Continue from the existing result and respond without calling it again.')
        }
        state.taskPrepareStarted = true
      } else if (lifecycle === 'curator_check') {
        if (state.curatorCheckStarted) {
          throw new Error('Kiokuko loop guard: curator_check is limited to once per user request. Reuse the displayed candidates or continue to the final checkpoint.')
        }
        state.curatorCheckStarted = true
      } else if (lifecycle === 'memory_checkpoint') {
        if (state.checkpointStarted) {
          throw new Error('Kiokuko loop guard: memory_checkpoint is limited to once per user request. Do not retry it; return the final response.')
        }
        state.checkpointStarted = true
      } else if (state.checkpointCompleted) {
        throw new Error('Kiokuko loop guard: memory_checkpoint completed, so the tool phase is closed. Return the final response without another tool call.')
      }

      const callFingerprint = await fingerprint({ tool: input.tool, args: output.args })
      if (callFingerprint === state.lastCallFingerprint) state.repeatedCallCount += 1
      else {
        state.lastCallFingerprint = callFingerprint
        state.repeatedCallCount = 1
      }
      if (state.repeatedCallCount > MAX_CONSECUTIVE_REPEATS) {
        state.blockedReason = 'Kiokuko loop guard: blocked a fourth consecutive tool call with identical arguments. Summarize current progress and stop calling tools.'
        throw new Error(state.blockedReason)
      }
    },
    'tool.execute.after': async (input, output) => {
      const state = stateFor(input.sessionID)
      if (lifecycleTool(input.tool) === 'task_prepare' && toolSucceeded(output)) state.taskPrepareCompleted = true
      if (lifecycleTool(input.tool) === 'memory_checkpoint' && toolSucceeded(output)) state.checkpointCompleted = true

      if (!isReadOnlyDiscoveryTool(input.tool)) {
        state.lastResultFingerprint = undefined
        state.repeatedResultCount = 0
        return
      }
      const resultFingerprint = await fingerprint({ tool: input.tool, title: output.title, output: output.output, metadata: output.metadata })
      if (resultFingerprint === state.lastResultFingerprint) state.repeatedResultCount += 1
      else {
        state.lastResultFingerprint = resultFingerprint
        state.repeatedResultCount = 1
      }
      if (state.repeatedResultCount >= MAX_CONSECUTIVE_REPEATS) {
        state.blockedReason = 'Kiokuko loop guard: three consecutive tool calls produced the same result. Summarize current progress and stop calling tools.'
      }
    },
    dispose: async () => {
      sessions.clear()
    },
  }
}
`;

export interface OpenCodeLoopGuardOptions {
  captureProfile?: OpenCodeCaptureProfile;
  mode?: OpenCodeMode;
}

function configuredLoopGuardSource(options: OpenCodeLoopGuardOptions = {}): string {
  const captureProfile = options.captureProfile ?? 'off';
  const mode = options.mode ?? 'advisory';
  if (captureProfile === 'off' && mode === 'advisory') return LOOP_GUARD_SOURCE;
  const injected = `
const OPENCODE_CAPTURE_PROFILE = ${JSON.stringify(captureProfile)}
const OPENCODE_MODE = ${JSON.stringify(mode)}
function capturePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500 || /[\\u0000-\\u001f\\u007f]/u.test(value) || value.startsWith('/') || /^[A-Za-z]:[\\\\/]/u.test(value) || value.split(/[\\\\/]/u).includes('..')) return undefined
  return value.replaceAll('\\\\', '/')
}
function captureSafe(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500 || /[\\u0000-\\u001f\\u007f]/u.test(value) || /(?:api[_-]?key|token|password|secret|authorization)/iu.test(value)) return undefined
  return value
}
function captureState(state) {
  if (!state.evidence) state.evidence = { changedPaths: [], errorSignatures: [], commands: [], tests: [] }
  return state.evidence
}
function captureBefore(state, input, output) {
  if (OPENCODE_CAPTURE_PROFILE === 'off') return
  const evidence = captureState(state)
  const args = output && output.args && typeof output.args === 'object' && !Array.isArray(output.args) ? output.args : {}
  const metadata = output && output.metadata && typeof output.metadata === 'object' && !Array.isArray(output.metadata) ? output.metadata : {}
  const paths = [...(Array.isArray(args.changedPaths) ? args.changedPaths : []), ...(Array.isArray(metadata.changedPaths) ? metadata.changedPaths : [])].map(capturePath).filter(Boolean)
  evidence.changedPaths = [...new Set([...(evidence.changedPaths || []), ...paths])].slice(0, 100)
  evidence.commands = [...(evidence.commands || []), { executable: String(input.tool).toLowerCase().replace(/[^a-z0-9_.-]+/gu, '_').slice(0, 200), classification: 'opencode-tool', outcome: 'unknown' }].slice(-100)
}
function captureAfter(state, input, output) {
  if (OPENCODE_CAPTURE_PROFILE !== 'standard') return
  const evidence = captureState(state)
  const metadata = output && output.metadata && typeof output.metadata === 'object' && !Array.isArray(output.metadata) ? output.metadata : {}
  const error = captureSafe(metadata.errorSignature)
  if (error) evidence.errorSignatures = [...new Set([...(evidence.errorSignatures || []), error])].slice(0, 100)
  const runner = captureSafe(metadata.testRunner)
  if (runner) evidence.tests = [...(evidence.tests || []), { runner, ...(captureSafe(metadata.testTarget) ? { target: captureSafe(metadata.testTarget) } : {}), outcome: 'unknown' }].slice(-100)
  if (['fresh', 'stale', 'failed', 'unknown'].includes(metadata.verification)) evidence.verification = { outcome: metadata.verification }
}
function mergeCheckpointEvidence(args, captured) {
  const existing = args && typeof args.evidence === 'object' && !Array.isArray(args.evidence) ? args.evidence : {}
  args.evidence = {
    ...(existing.changedPaths || captured.changedPaths ? { changedPaths: [...new Set([...(existing.changedPaths || []), ...(captured.changedPaths || [])])].slice(0, 100) } : {}),
    ...(existing.errorSignatures || captured.errorSignatures ? { errorSignatures: [...new Set([...(existing.errorSignatures || []), ...(captured.errorSignatures || [])])].slice(0, 100) } : {}),
    ...(existing.commands || captured.commands ? { commands: [...(existing.commands || []), ...(captured.commands || [])].slice(-100) } : {}),
    ...(existing.tests || captured.tests ? { tests: [...(existing.tests || []), ...(captured.tests || [])].slice(-100) } : {}),
    ...(existing.verification || captured.verification ? { verification: captured.verification || existing.verification } : {}),
  }
}
`;
  let source = LOOP_GUARD_SOURCE.replace("    blockedReason: undefined,\n", "    blockedReason: undefined,\n    evidence: { changedPaths: [], errorSignatures: [], commands: [], tests: [] },\n");
  source = source.replace("const MAX_AGENT_STEPS = 12", `${injected}\nconst MAX_AGENT_STEPS = 12`);
  source = source.replace("      const lifecycle = lifecycleTool(input.tool)\n", "      const lifecycle = lifecycleTool(input.tool)\n      if (OPENCODE_MODE === 'strict' && !state.taskPrepareCompleted && lifecycle !== 'task_prepare' && !isReadOnlyDiscoveryTool(input.tool)) throw new Error('Kiokuko strict mode: call task_prepare once before mutating tools.')\n");
  source = source.replace("      const callFingerprint = await fingerprint({ tool: input.tool, args: output.args })", "      captureBefore(state, input, output)\n      if (lifecycle === 'memory_checkpoint' && OPENCODE_CAPTURE_PROFILE !== 'off') { if (!output.args || typeof output.args !== 'object' || Array.isArray(output.args)) output.args = {}; mergeCheckpointEvidence(output.args, state.evidence) }\n      const callFingerprint = await fingerprint({ tool: input.tool, args: output.args })");
  source = source.replace("      const state = stateFor(input.sessionID)\n      if (lifecycleTool(input.tool) === 'memory_checkpoint')", "      const state = stateFor(input.sessionID)\n      captureAfter(state, input, output)\n      if (lifecycleTool(input.tool) === 'memory_checkpoint')");
  return source;
}

export function renderOpenCodeLoopGuard(existing: string | undefined, options: OpenCodeLoopGuardOptions = {}): DelimitedBlockResult {
  if (options.captureProfile !== undefined && !OPENCODE_CAPTURE_PROFILES.includes(options.captureProfile)) {
    throw new KiokukoError('VALIDATION_ERROR', 'OpenCode capture profile is invalid');
  }
  if (options.mode !== undefined && !OPENCODE_MODES.includes(options.mode)) {
    throw new KiokukoError('VALIDATION_ERROR', 'OpenCode mode is invalid');
  }
  if (existing !== undefined && !existing.startsWith(OPENCODE_LOOP_GUARD_MARKER)) {
    throw new KiokukoError('CONFLICT', 'OpenCode loop guard path contains an unmanaged file; move or remove it before running setup');
  }
  const eol = existing?.includes('\r\n') ? '\r\n' : '\n';
  const content = configuredLoopGuardSource(options).replaceAll('\n', eol);
  return {
    content,
    action: existing === undefined ? 'created' : existing === content ? 'unchanged' : 'updated',
  };
}
