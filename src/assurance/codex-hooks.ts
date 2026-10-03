import * as z from 'zod/v4';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { LedgerStore } from '../ledger/store.js';
import { KiokukoError } from '../errors.js';
import { assuranceState, taskAssuranceReport, insertTaskEvidence, memoryReviewNextAction } from './service.js';
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
interface HookCall extends SqliteRow { run_id: string; delivery_id: string | null; input_digest: string; state_digest: string; evidence_id: string | null; post_state_digest: string | null; }
export function codexHookCorrelationId(fields: Record<string, unknown>): string {
  const parts = [fields.session_id, fields.turn_id, fields.tool_use_id];
  return parts.every(value => typeof value === 'string')
    ? createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16) : 'unavailable';
}
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
  return {
    systemMessage: `Kiokuko blocked this tool call: ${reason}`,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  };
}
function context(event: string, text: string) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}
function memoryStepContext(db: SqliteDatabase, runId: string, root: string) {
  const report = taskAssuranceReport(db, runId, false);
  const nextAction = memoryReviewNextAction(report);
  const identity = JSON.stringify({ cwd: root, runId });
  if (nextAction === 'refresh_memory') return context('PostToolUse', `Next action: refresh_memory. Call task_memory_status with ${identity}, then task_memory_refresh on this run with the latest revision and bound capability catalog. Review the new delivery before ordinary tools. Use task_inspect for bounded evidence reads.`);
  if (nextAction === 'review_memory_application') return context('PostToolUse', `Next action: review_memory_application (${report.pending.length} pending). Call task_memory_status with ${identity}, then task_memory_review for every pending entry. Use task_inspect for evidence and bundled Skills, including natural-japanese-output; do not use shell commands or code search yet. Submit reviews sequentially with the revision from the latest response. Register grounded adoption, inapplicability or contradiction; never invent decisions to unlock execution. After the last review, check task_memory_status. Do not repeat task_prepare.`);
  return context('PostToolUse', 'Memory decisions are current; ordinary tools may proceed for this active run. Adopted code memories still require passing verification before completion.');
}
const preparationTools = new Set(['memory_index_submit', 'memory_index_review', 'task_inspect', 'task_prepare', 'task_prepare_recover', 'task_answer', 'task_memory_review', 'task_memory_status', 'task_memory_refresh', 'task_execution_evidence', 'memory_checkpoint', 'memory_capture', 'memory_recall', 'handoff_save', 'handoff_load', 'handoff_discard', 'curator_check']);
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
    return context(input.hook_event_name, `Kiokuko request ${requestId}. Before project work, call task_inspect with {"cwd":${JSON.stringify(root)},"operation":"skill"} (omit path to read kiokuko-soul). Read memory-reasoning through task_inspect before advertising it, then call task_prepare with this requestId and soulRead=true. Use task_inspect for all preparation reads and bundled Skills, including natural-japanese-output; do not read Skills through shell commands. After intake, resolve every pending or stale memory decision before ordinary tools, code search or execution. Follow nextAction; use task_memory_status and sequential task_memory_review calls with the latest revision. Ordinary conversation needs no project run. ${CODEX_HOOK_LIMITATION}`);
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
    if (operation === 'task_prepare_recover') {
      const receipt = db.prepare('SELECT successor_run_id FROM task_preparation_recoveries WHERE predecessor_run_id=?')
        .get<{ successor_run_id: string }>(String(args.runId));
      if (args.requestId !== requestId
        || (args.runId !== request.run_id && receipt?.successor_run_id !== request.run_id)
        || typeof args.cwd !== 'string' || realpathSync(args.cwd) !== root) {
        return deny('Recovery must match the pending client request and predecessor');
      }
      return {};
    }
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
    if (!request.run_id) return deny(`Read kiokuko-soul with task_inspect {"cwd":${JSON.stringify(root)},"operation":"skill"} (omit path), then complete task_prepare. task_inspect also permits bounded preparation reads.`);
    if (request.state !== 'bound') return deny('Kiokuko preparation has not permitted progress; resolve the current intake or required capability gate.');
    const run = new LedgerStore(db).readRun(request.run_id);
    if (!run || run.status !== 'active') return deny('Kiokuko intake is unfinished or the run is terminal');
    const report = taskAssuranceReport(db, request.run_id, false);
    if (report.pending.length || report.stale.length) return deny(`Memory review is incomplete (${report.pending.length} pending, ${report.stale.length} stale). The agent must call task_memory_status, ${report.stale.length ? 'then task_memory_refresh on the same run for stale entries,' : ''} then task_memory_review for each unresolved entry using the current revision returned by the latest response. Use task_inspect for bounded reads while reviews are pending. This tool call did not execute.`);
    const state = assuranceState(db, request.run_id)!;
    const inputDigest = canonicalContentHash(input.tool_input ?? null);
    let stateDigest: string;
    try { stateDigest = repositoryStateDigest(root); }
    catch { throw new KiokukoError('SERVICE_UNAVAILABLE', 'Repository state digest unavailable'); }
    const admission = withImmediateTransaction(db, () => {
      const current = db.prepare('SELECT * FROM codex_hook_requests WHERE identity_digest = ?').get<HookRequest>(identity);
      const currentRun = current?.run_id ? new LedgerStore(db).readRun(current.run_id) : null;
      const currentState = current?.run_id ? assuranceState(db, current.run_id) : null;
      if (!current || current.state !== 'bound' || current.run_id !== request!.run_id || currentRun?.status !== 'active'
        || currentState?.delivery_id !== state.delivery_id) return 'stale';
      const prior = db.prepare('SELECT input_digest FROM codex_hook_tools WHERE identity_digest = ? AND call_id = ?').get<{ input_digest: string }>(identity, input.tool_use_id!);
      if (prior) return prior.input_digest === inputDigest ? 'accepted' : 'conflict';
      db.prepare('INSERT INTO codex_hook_tools(identity_digest, call_id, run_id, delivery_id, input_digest, state_digest, evidence_id) VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run(identity, input.tool_use_id!, request!.run_id, state.delivery_id, inputDigest, stateDigest);
      return 'accepted';
    });
    if (admission === 'stale') return deny('Task state changed before tool admission');
    if (admission === 'conflict') return deny('Tool call identity was reused with different input');
    return {};
  }
  if (operation === 'task_prepare_recover') {
    const result = responseData(input.tool_response);
    const successor = record(result.run).runId;
    if (typeof successor !== 'string') return {};
    const receipt = db.prepare('SELECT * FROM task_preparation_recoveries WHERE predecessor_run_id=?')
      .get<{ successor_run_id: string; logical_request_hash: string; operation_hash: string }>(String(args.runId));
    if (!receipt || receipt.successor_run_id !== successor
      || receipt.logical_request_hash !== canonicalContentHash(requestId)
      || receipt.operation_hash !== canonicalContentHash(args.operationId)
      || (result.recoveredFromRunId !== request.run_id && successor !== request.run_id)
      || assuranceState(db, successor)?.repository_root !== root) {
      throw new KiokukoError('CONFLICT', 'Recovery response does not match durable client binding');
    }
    const admitted = ['proceed', 'review_memory_application', 'refresh_memory'].includes(String(result.nextAction));
    db.prepare('UPDATE codex_hook_requests SET run_id=?,state=? WHERE identity_digest=?')
      .run(successor, admitted ? 'bound' : 'pending', identity);
    return admitted ? memoryStepContext(db, successor, root) : {};
  }
  if (operation === 'task_prepare' || operation === 'task_answer') {
    const result = responseData(input.tool_response);
    const runId = record(result.run).runId;
    if (typeof runId !== 'string') return context('PostToolUse', 'Preparation failed; no client binding was created.');
    const state = assuranceState(db, runId);
    if (!state || state.repository_root !== root || (operation === 'task_prepare' && args.requestId !== requestId)
      || (operation === 'task_answer' && runId !== request.run_id)) throw new KiokukoError('CONFLICT', 'Preparation response does not match the observed client request');
    if (request.run_id && request.run_id !== runId) throw new KiokukoError('CONFLICT', 'Client request already binds another run');
    // Intake binding and memory admission are separate: reviews must be able to
    // unlock a prepared run without replaying task_prepare or task_answer.
    const prepared = ['proceed', 'review_memory_application', 'refresh_memory'].includes(String(result.nextAction));
    db.prepare('UPDATE codex_hook_requests SET run_id = ?, state = ? WHERE identity_digest = ?').run(runId, prepared ? 'bound' : 'pending', identity);
    return prepared ? memoryStepContext(db, runId, root) : {};
  }
  if (['task_memory_review', 'task_memory_refresh'].includes(operation ?? '') && request.state === 'bound'
    && request.run_id && record(input.tool_response).isError !== true
    && new LedgerStore(db).readRun(request.run_id)?.status === 'active') return memoryStepContext(db, request.run_id, root);
  if (operation || !request.run_id) return {};
  const response = responseData(input.tool_response);
  // Unknown or unfinished client result shapes must never become passing evidence.
  const exitCode = observedExitCode(input.tool_response);
  // Each completion reads its own call and the current assurance revision under
  // the writer lock. A different call may have advanced that revision already.
  return withImmediateTransaction(db, () => {
    const current = db.prepare('SELECT * FROM codex_hook_requests WHERE identity_digest = ?').get<HookRequest>(identity);
    const call = db.prepare('SELECT * FROM codex_hook_tools WHERE identity_digest = ? AND call_id = ?').get<HookCall>(identity, input.tool_use_id!);
    if (!current || current.run_id !== request!.run_id || current.state !== 'bound')
      throw new KiokukoError('CONFLICT', 'Tool completion binding changed');
    if (!call) throw new KiokukoError('CONFLICT', 'Tool completion has no matching start');
    if (call.run_id !== current.run_id) throw new KiokukoError('CONFLICT', 'Tool completion binding changed');
    if (call.input_digest !== canonicalContentHash(input.tool_input ?? null))
      throw new KiokukoError('CONFLICT', 'Tool completion input changed');
    const run = new LedgerStore(db).readRun(current.run_id!);
    if (!run || run.status !== 'active') throw new KiokukoError('CONFLICT', 'Tool completion belongs to a terminal run');
    const state = assuranceState(db, current.run_id!);
    if (!state || state.repository_root !== root) throw new KiokukoError('CONFLICT', 'Tool completion repository changed');
    if (call.delivery_id !== state.delivery_id) return context('PostToolUse', 'Delivery changed during execution; completion cannot verify the new delivery.');
    if (call.evidence_id) return context('PostToolUse', `Execution evidence: ${call.evidence_id}`);
    let digest: string;
    try { digest = repositoryStateDigest(root); }
    catch { throw new KiokukoError('SERVICE_UNAVAILABLE', 'Repository state digest unavailable'); }
    if (digest !== call.state_digest) {
      if (!call.post_state_digest) {
        db.prepare('UPDATE task_assurance SET observed_changes=1, revision=revision+1 WHERE run_id=?').run(current.run_id);
        db.prepare('UPDATE codex_hook_tools SET post_state_digest=? WHERE identity_digest=? AND call_id=?').run(digest, identity, input.tool_use_id!);
      }
      return context('PostToolUse', 'Repository state changed; earlier verification is stale. Implementation evidence is now required for adopted code memories.');
    }
    if (!['Bash', 'exec_command'].includes(input.tool_name!)) return {};
    if (response.session_id !== undefined && exitCode === null) return context('PostToolUse', 'Process still running; verification remains pending.');
    const outcome = exitCode === null ? 'unknown' : exitCode === 0 ? 'passed' : 'failed';
    const evidenceId = insertTaskEvidence(db, { runId: current.run_id!, deliveryId: state.delivery_id, root, cwd: root,
      executionDigest: call.input_digest, stateDigest: digest, outcome, exitCode, provenance: 'client_observed' });
    db.prepare('UPDATE codex_hook_tools SET evidence_id = ? WHERE identity_digest = ? AND call_id = ?').run(evidenceId, identity, input.tool_use_id!);
    db.prepare('UPDATE task_assurance SET revision=revision+1, updated_at=? WHERE run_id=?').run(now, current.run_id);
    return context('PostToolUse', `Execution evidence: ${evidenceId}; outcome: ${outcome}. Link it with task_memory_review.`);
  });
}

/** Record protocol shape and decision only, never arguments or tool output. */
export function handleCodexHook(db: SqliteDatabase, raw: unknown): object {
  const input = parseAssurance(hookSchema, raw);
  const response = record(input.tool_response);
  const args = record(input.tool_input);
  const shape = { hasArguments: !!args.arguments, hasParameters: !!args.parameters, hasRequestId: !!args.requestId, hasSoulRead: !!args.soulRead, type: typeof input.tool_response, structured: !!response.structuredContent,
    content: Array.isArray(response.content), exitCode: typeof response.exit_code, status: typeof response.status };
  const save = (decision: string, reason?: string) => withImmediateTransaction(db, () => {
    const diagnostic = { ...shape, reason, call: codexHookCorrelationId(input) };
    db.prepare('INSERT INTO codex_hook_observations VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), input.hook_event_name, input.tool_name ?? null, JSON.stringify(diagnostic), decision, new Date().toISOString());
    db.prepare('DELETE FROM codex_hook_observations WHERE rowid NOT IN (SELECT rowid FROM codex_hook_observations ORDER BY rowid DESC LIMIT 1000)').run();
  });
  try {
    const result = handleCodexHookEvent(db, input);
    const specific = record(record(result).hookSpecificOutput);
    try { save(specific.permissionDecision === 'deny' ? 'denied' : 'handled', specific.permissionDecision === 'deny' ? 'policy_denied' : undefined); }
    catch { process.stderr.write('Kiokuko hook observation unavailable: observation_write_failed.\n'); }
    return result;
  } catch (error) {
    try { save(error instanceof KiokukoError ? error.code : 'adapter_error', codexHookFailureCode(error)); }
    catch { /* Preserve the primary failure. */ }
    throw error;
  }
}
export function codexHookFailureCode(error: unknown): string {
  if (error instanceof KiokukoError) {
    if (error.code === 'CONFLICT') {
      if (error.message === 'Tool completion has no matching start') return 'completion_without_admission';
      if (error.message === 'Tool completion input changed') return 'completion_input_mismatch';
      if (error.message === 'Tool completion binding changed') return 'completion_binding_changed';
      return 'state_conflict';
    }
    if (error.code === 'BACKPRESSURE') return 'database_busy';
    if (error.code === 'SERVICE_UNAVAILABLE' && error.message === 'Repository state digest unavailable') return 'state_digest_unavailable';
    if (error.code === 'VALIDATION_ERROR' || error.code === 'INTEGRITY_ERROR') return 'validation_unavailable';
    return 'kiokuko_error';
  }
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('ERR_SQLITE')) return 'database_error';
  return 'adapter_error';
}
