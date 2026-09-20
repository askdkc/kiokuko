import * as z from 'zod/v4';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { LedgerStore } from '../ledger/store.js';
import { KiokukoError } from '../errors.js';
import { assuranceState, taskAssuranceReport, recordTaskEvidence } from './service.js';
import { repositoryStateDigest } from './snapshot.js';
import { parseAssurance } from './contracts.js';

export const CODEX_HOOK_LIMITATION = 'Hooks cover supported client paths only. They do not isolate execution, control an already running process or retract an emitted response. Configuration is not proof of active runtime enforcement.';
const bounded = z.string().min(1).max(500);
const hookSchema = z.object({
  hook_event_name: z.enum(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Interrupt', 'SubagentStart', 'SubagentStop']),
  session_id: bounded, turn_id: bounded, cwd: bounded, agent_id: bounded.optional(),
  tool_name: bounded.optional(), tool_use_id: bounded.optional(), tool_input: z.unknown().optional(), tool_response: z.unknown().optional(),
  stop_hook_active: z.boolean().optional(),
}).passthrough();
interface HookRequest extends SqliteRow { identity_digest: string; repository_root: string; run_id: string | null; request_id: string; state: string; }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function responseData(value: unknown): Record<string, unknown> {
  const outer = record(value);
  if (outer.isError === true) return {};
  if (outer.structuredContent) return record(outer.structuredContent);
  if (Array.isArray(outer.content)) {
    for (const block of outer.content) {
      const item = record(block);
      if (item.type === 'text' && typeof item.text === 'string') {
        try { return record(JSON.parse(item.text)); } catch { /* Non-JSON output is not a task binding. */ }
      }
    }
  }
  return outer;
}
/** stdout strings are never completion metadata, even when they contain JSON or exit headers. */
export function observedExitCode(value: unknown): number | null {
  const response = record(value);
  return typeof response.exit_code === 'number' && Number.isSafeInteger(response.exit_code) ? response.exit_code : null;
}
function deny(reason: string) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}
function context(event: string, text: string) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}
const preparationTools = new Set(['task_inspect', 'task_prepare', 'task_answer', 'task_memory_review', 'task_memory_status', 'task_memory_refresh', 'task_execution_evidence', 'memory_checkpoint', 'memory_capture', 'memory_recall', 'curator_check']);
function kiokukoTool(name: string): string | null {
  const match = /^mcp__kiokuko__(\w+)$/.exec(name);
  return match && preparationTools.has(match[1]!) ? match[1]! : null;
}
/** stdin must come from the installed client hook. Session IDs supplied to model-facing APIs grant no authority. */
function handleCodexHookEvent(db: SqliteDatabase, raw: unknown): object {
  const input = parseAssurance(hookSchema, raw);
  const root = realpathSync(execFileSync('git', ['-C', realpathSync(input.cwd), 'rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: 5000 }).trim());
  const identity = canonicalContentHash({ session: input.session_id, turn: input.turn_id, agent: input.agent_id ?? 'main', root });
  const requestId = `codex-${identity}`;
  const now = new Date().toISOString();
  let request = db.prepare('SELECT * FROM codex_hook_requests WHERE identity_digest = ?').get<HookRequest>(identity);
  if (input.hook_event_name === 'UserPromptSubmit' || input.hook_event_name === 'SubagentStart') {
    withImmediateTransaction(db, () => {
      db.prepare("INSERT INTO codex_hook_requests VALUES (?, ?, NULL, ?, 'pending', 0, ?, ?) ON CONFLICT(identity_digest) DO UPDATE SET last_event=excluded.last_event, updated_at=excluded.updated_at")
        .run(identity, root, requestId, input.hook_event_name, now);
    });
    return context(input.hook_event_name, `Kiokuko request ${requestId}. Before project work, read kiokuko-soul using task_inspect and call task_prepare with this requestId. Use task_inspect for bounded preparation reads. Ordinary conversation needs no project run. ${CODEX_HOOK_LIMITATION}`);
  }
  if (!request) {
    if (input.hook_event_name === 'Interrupt' || input.hook_event_name === 'SubagentStop') return {};
    if (input.hook_event_name === 'PreToolUse') return deny('Kiokuko has not observed this request start. Parent-agent preparation is not inherited.');
    throw new KiokukoError('CONFLICT', 'Hook request start was not observed');
  }
  db.prepare('UPDATE codex_hook_requests SET last_event = ?, updated_at = ? WHERE identity_digest = ?').run(input.hook_event_name, now, identity);
  if (input.hook_event_name === 'Interrupt') {
    withImmediateTransaction(db, () => {
      db.prepare("UPDATE codex_hook_requests SET state = 'cancelled' WHERE identity_digest = ?").run(identity);
      if (request!.run_id) {
        const store = new LedgerStore(db);
        const run = store.readRun(request!.run_id);
        if (run && (run.status === 'active' || run.status === 'intake')) store.updateRunStatusInTransaction(run.runId, 'interrupted', now);
      }
    });
    return {}; // Never request continuation after cancellation.
  }
  if (request.state === 'cancelled') return input.hook_event_name === 'PreToolUse' ? deny('Request was interrupted') : {};
  if (input.hook_event_name === 'Stop' || input.hook_event_name === 'SubagentStop') {
    if (!request.run_id) return {}; // Ordinary conversation never required a run.
    const run = new LedgerStore(db).readRun(request.run_id);
    // Terminal completion was already gated transactionally by the domain service.
    if (run && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return {};
    if (request.state !== 'bound') return { continue: false, stopReason: 'Kiokuko preparation or capability gate is incomplete' };
    const report = taskAssuranceReport(db, request.run_id);
    if (!report.complete) return { continue: false, stopReason: 'Memory application or regression evidence is incomplete', systemMessage: JSON.stringify(report) };
    return {};
  }
  if (!input.tool_name || !input.tool_use_id) throw new KiokukoError('VALIDATION_ERROR', 'Hook tool identity is missing');
  const operation = kiokukoTool(input.tool_name);
  const args = record(input.tool_input);
  if (input.hook_event_name === 'PreToolUse') {
    if (['spawn_agent', 'Agent'].includes(input.tool_name)) return deny('Delegation requires a client adapter that supplies distinct agent identity on every child tool event.');
    if (operation === 'task_prepare') {
      // Validate rather than rewrite: MCP updatedInput can trigger client approval.
      // The model must supply its own read attestation and request binding.
      if (args.requestId !== requestId || typeof args.cwd !== 'string' || realpathSync(args.cwd) !== root) return deny(`Use requestId ${requestId} and cwd ${root} for this request.`);
      return {};
    }
    if (operation) {
      if (args.runId !== undefined && args.runId !== request.run_id) return deny('Tool run is not bound to this client request');
      return {};
    }
    if (!request.run_id) return deny('Read kiokuko-soul and complete task_prepare first; task_inspect is available for preparation.');
    if (request.state !== 'bound') return deny('Kiokuko preparation has not permitted progress; resolve the current intake or required capability gate.');
    const run = new LedgerStore(db).readRun(request.run_id);
    if (!run || run.status !== 'active') return deny('Kiokuko intake is unfinished or the run is terminal');
    const report = taskAssuranceReport(db, request.run_id, false);
    if (report.pending.length || report.stale.length) return deny('Resolve current memory application decisions before editing or executing.');
    const state = assuranceState(db, request.run_id)!;
    const inputDigest = canonicalContentHash(input.tool_input ?? null);
    const prior = db.prepare('SELECT input_digest FROM codex_hook_tools WHERE identity_digest = ? AND call_id = ?').get<{ input_digest: string }>(identity, input.tool_use_id);
    if (prior && prior.input_digest !== inputDigest) return deny('Tool call identity was reused with different input');
    db.prepare('INSERT OR IGNORE INTO codex_hook_tools(identity_digest, call_id, run_id, delivery_id, input_digest, state_digest, evidence_id) VALUES (?, ?, ?, ?, ?, ?, NULL)')
      .run(identity, input.tool_use_id, request.run_id, state.delivery_id, inputDigest, repositoryStateDigest(root));
    return {};
  }
  if (operation === 'task_prepare' || operation === 'task_answer') {
    const result = responseData(input.tool_response);
    const runId = record(result.run).runId;
    if (typeof runId !== 'string') return context('PostToolUse', 'Preparation failed; no client binding was created.');
    const state = assuranceState(db, runId);
    if (!state || state.repository_root !== root || (operation === 'task_prepare' && args.requestId !== requestId)
      || (operation === 'task_answer' && runId !== request.run_id)) throw new KiokukoError('CONFLICT', 'Preparation response does not match the observed client request');
    if (request.run_id && request.run_id !== runId) throw new KiokukoError('CONFLICT', 'Client request already binds another run');
    db.prepare('UPDATE codex_hook_requests SET run_id = ?, state = ? WHERE identity_digest = ?').run(runId, result.nextAction === 'proceed' ? 'bound' : 'pending', identity);
    return {};
  }
  if (operation || !request.run_id) return {};
  const call = db.prepare('SELECT * FROM codex_hook_tools WHERE identity_digest = ? AND call_id = ?').get<SqliteRow>(identity, input.tool_use_id);
  if (!call || call.run_id !== request.run_id || call.input_digest !== canonicalContentHash(input.tool_input ?? null)) throw new KiokukoError('CONFLICT', 'Tool completion has no matching start');
  if (call.evidence_id) return context('PostToolUse', `Execution evidence: ${call.evidence_id}`);
  const digest = repositoryStateDigest(root);
  const state = assuranceState(db, request.run_id)!;
  if (digest !== call.state_digest) {
    if (!call.post_state_digest) withImmediateTransaction(db, () => {
      db.prepare('UPDATE task_assurance SET observed_changes=1, revision=revision+1 WHERE run_id=?').run(request!.run_id);
      db.prepare('UPDATE codex_hook_tools SET post_state_digest=? WHERE identity_digest=? AND call_id=?').run(digest, identity, input.tool_use_id!);
    });
    return context('PostToolUse', 'Repository state changed; earlier verification is stale. Implementation evidence is now required for adopted code memories.');
  }
  if (call.delivery_id !== state.delivery_id) return context('PostToolUse', 'Delivery changed during execution; completion cannot verify the new delivery.');
  if (!['Bash', 'exec_command'].includes(input.tool_name)) return {};
  const response = responseData(input.tool_response);
  // Unknown or unfinished client result shapes must never become passing evidence.
  const exitCode = observedExitCode(input.tool_response);
  if (response.session_id !== undefined && exitCode === null) return context('PostToolUse', 'Process still running; verification remains pending.');
  const evidence = recordTaskEvidence(db, { runId: request.run_id, requestId: `hook-${input.tool_use_id}`, expectedRevision: state.revision,
    cwd: root, deliveryId: state.delivery_id, execution: JSON.stringify(input.tool_input).slice(0, 4000), stateDigest: digest,
    outcome: exitCode === null ? 'unknown' : exitCode === 0 ? 'passed' : 'failed', exitCode }, 'client_observed', { executionDigest: canonicalContentHash(input.tool_input ?? null), onRecorded: evidenceId => {
    db.prepare('UPDATE codex_hook_tools SET evidence_id = ? WHERE identity_digest = ? AND call_id = ?').run(evidenceId, identity, input.tool_use_id!);
  } });
  return context('PostToolUse', `Execution evidence: ${evidence.evidenceId}; outcome: ${evidence.outcome}. Link it with task_memory_review.`);
}

/** Record protocol shape and decision only, never arguments or tool output. */
export function handleCodexHook(db: SqliteDatabase, raw: unknown): object {
  const input = parseAssurance(hookSchema, raw);
  const response = record(input.tool_response);
  const args = record(input.tool_input);
  const shape = JSON.stringify({ hasArguments: !!args.arguments, hasParameters: !!args.parameters, hasRequestId: !!args.requestId, hasSoulRead: !!args.soulRead, type: typeof input.tool_response, structured: !!response.structuredContent,
    content: Array.isArray(response.content), exitCode: typeof response.exit_code, status: typeof response.status });
  const save = (decision: string) => withImmediateTransaction(db, () => {
    db.prepare('INSERT INTO codex_hook_observations VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), input.hook_event_name, input.tool_name ?? null, shape, decision, new Date().toISOString());
    db.prepare('DELETE FROM codex_hook_observations WHERE rowid NOT IN (SELECT rowid FROM codex_hook_observations ORDER BY rowid DESC LIMIT 1000)').run();
  });
  try {
    const result = handleCodexHookEvent(db, input);
    const specific = record(record(result).hookSpecificOutput);
    save(specific.permissionDecision === 'deny' ? 'denied' : 'handled');
    return result;
  } catch (error) {
    save(error instanceof KiokukoError ? error.code : 'adapter_error');
    throw error;
  }
}
