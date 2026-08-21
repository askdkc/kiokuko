import { KiokukoError } from '../errors.js';
import type { DelimitedBlockResult } from './managed-text.js';

export const OPENCODE_LOOP_GUARD_MARKER = '// Managed by `kiokuko setup`: OpenCode loop guard v1';

const LOOP_GUARD_SOURCE = `${OPENCODE_LOOP_GUARD_MARKER}
const MAX_AGENT_STEPS = 12
const MAX_CONSECUTIVE_REPEATS = 3
const BUILTIN_AGENTS = ['build', 'plan', 'general', 'explore', 'scout']
const HIDDEN_AGENTS = new Set(['compaction', 'title', 'summary'])

function freshTurn(messageID) {
  return {
    messageID,
    taskPrepareStarted: false,
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
  if (normalized === 'kiokuko_memory_checkpoint' || normalized.endsWith('_kiokuko_memory_checkpoint')) return 'memory_checkpoint'
  return undefined
}

function capAgentSteps(config) {
  if (!config.agent || typeof config.agent !== 'object' || Array.isArray(config.agent)) config.agent = {}
  for (const name of BUILTIN_AGENTS) {
    if (!config.agent[name] || typeof config.agent[name] !== 'object' || Array.isArray(config.agent[name])) config.agent[name] = {}
  }
  for (const [name, agent] of Object.entries(config.agent)) {
    if (HIDDEN_AGENTS.has(name) || !agent || typeof agent !== 'object' || Array.isArray(agent)) continue
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
      if (!['session.idle', 'session.deleted', 'session.error'].includes(event.type)) return
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
      if (lifecycleTool(input.tool) === 'memory_checkpoint') state.checkpointCompleted = true

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

export function renderOpenCodeLoopGuard(existing: string | undefined): DelimitedBlockResult {
  if (existing !== undefined && !existing.startsWith(OPENCODE_LOOP_GUARD_MARKER)) {
    throw new KiokukoError('CONFLICT', 'OpenCode loop guard path contains an unmanaged file; move or remove it before running setup');
  }
  const eol = existing?.includes('\r\n') ? '\r\n' : '\n';
  const content = LOOP_GUARD_SOURCE.replaceAll('\n', eol);
  return {
    content,
    action: existing === undefined ? 'created' : existing === content ? 'unchanged' : 'updated',
  };
}
