import { INTEGRATION_CONTRACT, hostSkillText } from '../setup/standard-skills.js';
import { PACKAGE_VERSION } from '../package-version.js';
import * as z from 'zod/v4';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
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
interface HookRequest extends SqliteRow { identity_digest: string; repository_root: string; run_id: string | null; request_id: string; state: string; stop_notified: number; }
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
export const CODEX_EXECUTION_ADAPTER = { id: 'codex-hook/structured-exit-code-v1', rawOutputExitMetadata: false, structuredExitMetadata: true } as const;
export function observedExitCode(value: unknown): number | null {
  const response = record(value);
  if (response.session_id !== undefined || response.timed_out === true || response.interrupted === true || response.signal !== undefined || (response.status !== undefined && !['completed', 'finished'].includes(String(response.status))) || response.error !== undefined) return null;
  return typeof response.exit_code === 'number' && Number.isSafeInteger(response.exit_code) ? response.exit_code : null;
}
const turnStopReason = 'Kiokuko stopped this turn after a policy denial. Do not retry tools or attempt preparation/recovery. Report the blocker and wait for a new user message.';
function deny(reason: string, code = 'identity_violation', recoverable = false) {
  const message = recoverable ? reason : `${reason} ${turnStopReason}`;
  return {
    kiokukoDecision: { reason: code, recoverable, nextAction: recoverable ? 'repair_current_request' : 'stop_and_report' },
    systemMessage: `Kiokuko blocked this tool call: ${message}`,
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message },
  };
}
function stopTurn(event: string) {
  // SubagentStart cannot stop a child with continue:false. Its tool gate still denies.
  if (event === 'SubagentStart') return context(event, turnStopReason);
  return { continue: false, stopReason: turnStopReason, systemMessage: turnStopReason };
}
function context(event: string, text: string) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: hostSkillText(text, 'codex') } };
}
function memoryStepContext(db: SqliteDatabase, runId: string, root: string) {
  const report = taskAssuranceReport(db, runId, false);
  const nextAction = memoryReviewNextAction(report);
  const identity = JSON.stringify({ cwd: root, runId });
  if (nextAction === 'refresh_memory') return context('PostToolUse', `Next action: refresh_memory. Call task_memory_status with ${identity}, then task_memory_refresh on this run with the latest revision and bound capability catalog. Review the new delivery before ordinary tools. Use task_inspect for bounded evidence reads.`);
  if (nextAction === 'review_memory_application') return context('PostToolUse', `Next action: review_memory_application (${report.pending.length} pending). Call task_memory_status with ${identity}, then task_memory_review for every pending entry. Use task_inspect for evidence and bundled Skills, including natural-japanese-output; do not use shell commands or code search yet. Submit reviews sequentially with the revision from the latest response. Register grounded adoption, inapplicability or contradiction; never invent decisions to unlock execution. After the last review, check task_memory_status. Do not repeat task_prepare.`);
  return context('PostToolUse', 'Memory decisions are current; ordinary tools may proceed for this active run. Adopted code memories still require passing verification before completion.');
}
const preparationTools = new Set(['memory_index_submit', 'memory_index_review', 'task_inspect', 'task_prepare', 'task_prepare_recover', 'task_answer', 'task_memory_review', 'task_memory_status', 'task_memory_refresh', 'task_execution_evidence', 'task_verification_define', 'task_verification_record', 'memory_checkpoint', 'memory_capture', 'memory_recall', 'handoff_save', 'handoff_load', 'handoff_discard', 'curator_check']);
// Exact, observed non-execution tools. Never infer safety from names or shell text.
const conversationTools = new Set(['request_user_input', 'request_user_input_async', 'clockcurr_time']);
function kiokukoTool(name: string): string | null {
  const match = /^mcp__kiokuko__(\w+)$/.exec(name);
  return match && preparationTools.has(match[1]!) ? match[1]! : null;
}
/** No project is invented for ordinary conversation outside a checkout. */
function checkoutFreeHook(input: z.infer<typeof hookSchema>): object {
  if (input.hook_event_name === 'UserPromptSubmit') return context('UserPromptSubmit',
    'No Git checkout is available. For ordinary conversation, read kiokuko-soul and memory-reasoning with task_inspect operation skill, then use memory_recall with soulRead=true and the complete capability catalog. No project run or implementation checks are required. Project operations require an existing checkout; do not invent one.');
  if (input.hook_event_name !== 'PreToolUse') return {};
  const operation = kiokukoTool(input.tool_name ?? '');
  const args = record(input.tool_input);
  if (conversationTools.has(input.tool_name ?? '') || operation === 'memory_recall'
    || (operation === 'memory_capture' && args.runId === undefined)
    || (operation === 'task_inspect' && args.operation === 'skill')) return {};
  return deny('Project operations require an existing Git checkout. Ordinary conversation can use global memory and bundled Skill reads.', 'repository_required', true);
}
/** stdin must come from the installed client hook. Session IDs supplied to model-facing APIs grant no authority. */
function handleCodexHookEvent(db: SqliteDatabase, raw: unknown): object {
  const input = parseAssurance(hookSchema, raw);
  const cwd = realpathSync(input.cwd);
  let root: string;
  try {
    root = realpathSync(execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' },
    }).trim());
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    if (failure.status !== 128 || !/^fatal: not a git repository/mu.test(String(failure.stderr))) throw error;
    // Losing a checkout cannot turn an existing project run into an exempt inquiry.
    const bound = db.prepare(`SELECT 1 FROM codex_hook_requests WHERE run_id IS NOT NULL
      AND (repository_root=? OR substr(?,1,length(repository_root)+1)=repository_root||?) LIMIT 1`).get(cwd, cwd, path.sep);
    if (bound) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Bound repository is unavailable');
    return checkoutFreeHook(input);
  }
  const identity = canonicalContentHash({ session: input.session_id, turn: input.turn_id, agent: input.agent_id ?? 'main', root });
  const requestId = `codex-${identity}`;
  const now = new Date().toISOString();
  const recoverableDeny = (reason: string, code: string) => deny(reason, code, true);
  const denyTurn = (reason: string, code = 'identity_violation') => {
    withImmediateTransaction(db, () => {
      // Reuse the existing durable stop flag; exact event replay never clears it.
      db.prepare(`INSERT INTO codex_hook_requests
        (identity_digest, repository_root, run_id, request_id, state, stop_notified, last_event, updated_at)
        VALUES (?, ?, NULL, ?, 'pending', 1, ?, ?)
        ON CONFLICT(identity_digest) DO UPDATE SET stop_notified=1, last_event=excluded.last_event, updated_at=excluded.updated_at`)
        .run(identity, root, requestId, input.hook_event_name, now);
      const current = db.prepare('SELECT run_id FROM codex_hook_requests WHERE identity_digest=?').get<{ run_id: string | null }>(identity);
      if (current?.run_id) {
        const store = new LedgerStore(db);
        const run = store.readRun(current.run_id);
        if (run && (run.status === 'active' || run.status === 'intake')) store.updateRunStatusInTransaction(run.runId, 'failed', now);
      }
    });
    return deny(reason, code);
  };
  let request = db.prepare('SELECT * FROM codex_hook_requests WHERE identity_digest = ?').get<HookRequest>(identity);
  if (input.hook_event_name === 'UserPromptSubmit' || input.hook_event_name === 'SubagentStart') {
    if (request?.stop_notified) return stopTurn(input.hook_event_name);
    withImmediateTransaction(db, () => {
      db.prepare("INSERT INTO codex_hook_requests VALUES (?, ?, NULL, ?, 'pending', 0, ?, ?) ON CONFLICT(identity_digest) DO UPDATE SET last_event=excluded.last_event, updated_at=excluded.updated_at")
        .run(identity, root, requestId, input.hook_event_name, now);
    });
    if (db.prepare('SELECT stop_notified FROM codex_hook_requests WHERE identity_digest=?').get<HookRequest>(identity)?.stop_notified) return stopTurn(input.hook_event_name);
    return context(input.hook_event_name, `Kiokuko request ${requestId}. Before project work, call task_inspect with {"cwd":${JSON.stringify(root)},"operation":"skill"} (omit path to read kiokuko-soul). Read memory-reasoning through task_inspect before advertising it, then call task_prepare with this requestId and soulRead=true. Use task_inspect for all preparation reads and bundled Skills, including natural-japanese-output; do not read Skills through shell commands. After intake, resolve every pending or stale memory decision before ordinary tools, code search or execution. Follow nextAction; use task_memory_status and sequential task_memory_review calls with the latest revision. User clarification tools request_user_input and request_user_input_async, and the clockcurr_time read, remain available before preparation and memory review. Recoverable preparation or review denials block only the call; repair the same request through task_inspect, task_prepare/task_answer, task_memory_status/task_memory_refresh/task_memory_review. Identity or authorization denials end the turn. Ordinary conversation needs no project run. ${CODEX_HOOK_LIMITATION}`);
  }
  if (!request) {
    if (input.hook_event_name === 'Interrupt' || input.hook_event_name === 'SubagentStop') return {};
    if (input.hook_event_name === 'PreToolUse') return denyTurn('Kiokuko has not observed this request start. Parent-agent preparation is not inherited.', 'request_not_observed');
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
  if (request.state === 'cancelled') return input.hook_event_name === 'PreToolUse' ? denyTurn('Request was interrupted', 'request_interrupted') : {};
  if (request.stop_notified) return input.hook_event_name === 'PreToolUse' ? deny('This turn already had a policy denial.') : stopTurn(input.hook_event_name);
  if (input.hook_event_name === 'Stop' || input.hook_event_name === 'SubagentStop') {
    if (!request.run_id) return {}; // Ordinary conversation never required a run.
    const run = new LedgerStore(db).readRun(request.run_id);
    // Terminal completion was already gated transactionally by the domain service.
    if (run && ['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return {};
    if (request.state !== 'bound') return { continue: false, stopReason: 'Kiokuko preparation or capability gate is incomplete' };
    const report = taskAssuranceReport(db, request.run_id);
    if (!report.complete || report.completionReady === false) return { continue: false, stopReason: 'Memory application or required task verification is incomplete', systemMessage: JSON.stringify(report) };
    return {};
  }
  if (!input.tool_name || !input.tool_use_id) throw new KiokukoError('VALIDATION_ERROR', 'Hook tool identity is missing');
  if (conversationTools.has(input.tool_name)) return {};
  const operation = kiokukoTool(input.tool_name);
  const args = record(input.tool_input);
  if (input.hook_event_name === 'PreToolUse') {
    if (['spawn_agent', 'Agent'].includes(input.tool_name)) return denyTurn('Delegation requires a client adapter that supplies distinct agent identity on every child tool event.');
    if (operation === 'task_prepare_recover') {
      const receipt = db.prepare('SELECT successor_run_id FROM task_preparation_recoveries WHERE predecessor_run_id=?')
        .get<{ successor_run_id: string }>(String(args.runId));
      if (args.requestId !== requestId
        || (args.runId !== request.run_id && receipt?.successor_run_id !== request.run_id)
        || typeof args.cwd !== 'string' || realpathSync(args.cwd) !== root) {
        return denyTurn('Recovery must match the pending client request and predecessor');
      }
      return {};
    }
    if (operation === 'task_prepare') {
      // Validate rather than rewrite: MCP updatedInput can trigger client approval.
      // The model must supply its own read attestation and request binding.
      if (args.requestId !== requestId || typeof args.cwd !== 'string' || realpathSync(args.cwd) !== root) return denyTurn(`Use requestId ${requestId} and cwd ${root} for this request.`);
      return {};
    }
    if (operation) {
      const boundRun = request.run_id ? new LedgerStore(db).readRun(request.run_id) : null;
      if (boundRun && !['active', 'intake'].includes(boundRun.status)) return denyTurn('Bound run is terminal', 'run_terminal');
      if (typeof args.cwd === 'string' && realpathSync(args.cwd) !== root) return denyTurn('Tool repository is not bound to this client request', 'repository_binding_mismatch');
      if (args.runId !== undefined && args.runId !== request.run_id) return denyTurn('Tool run is not bound to this client request', 'run_binding_mismatch');
      if (args.runId !== undefined && !request.run_id) return denyTurn('No run is bound to this request');
      const report = request.run_id && request.state === 'bound' ? taskAssuranceReport(db, request.run_id, false) : null;
      const repairTools = new Set(['handoff_save', 'handoff_load', 'handoff_discard', 'memory_recall', 'memory_capture', 'task_inspect', 'task_answer', 'task_memory_status', 'task_memory_refresh', 'task_memory_review']);
      if ((!request.run_id || request.state !== 'bound' || report?.pending.length || report?.stale.length) && !repairTools.has(operation)) {
        return recoverableDeny('Complete preparation and memory review before this operation.', 'preparation_or_review_required');
      }
      return {};
    }
    if (!request.run_id) return recoverableDeny(`Preparation was missing: read kiokuko-soul with task_inspect {"cwd":${JSON.stringify(root)},"operation":"skill"} (omit path), then complete task_prepare in this turn. task_inspect also permits bounded preparation reads.`, 'preparation_required');
    if (request.state !== 'bound') return recoverableDeny('Complete the current intake or required capability gate.', 'intake_pending');
    const run = new LedgerStore(db).readRun(request.run_id);
    if (!run || run.status !== 'active') return denyTurn('Kiokuko intake is unfinished or the run is terminal', 'run_terminal');
    const report = taskAssuranceReport(db, request.run_id, false);
    if (report.pending.length || report.stale.length) return recoverableDeny(`Memory review is incomplete (${report.pending.length} pending, ${report.stale.length} stale). Required order: task_memory_status, ${report.stale.length ? 'then task_memory_refresh for stale entries,' : ''} then task_memory_review for each unresolved entry using the latest revision. Use task_inspect for bounded reads before attempting ordinary tools. This tool call did not execute.`, report.stale.length ? 'memory_stale' : 'memory_review_pending');
    const state = assuranceState(db, request.run_id)!;
    const inputDigest = canonicalContentHash(input.tool_input ?? null);
    let stateDigest: string;
    try { stateDigest = repositoryStateDigest(root); }
    catch { throw new KiokukoError('SERVICE_UNAVAILABLE', 'Repository state digest unavailable'); }
    const admission = withImmediateTransaction(db, () => {
      const current = db.prepare('SELECT * FROM codex_hook_requests WHERE identity_digest = ?').get<HookRequest>(identity);
      const currentRun = current?.run_id ? new LedgerStore(db).readRun(current.run_id) : null;
      const currentState = current?.run_id ? assuranceState(db, current.run_id) : null;
      if (!current || current.stop_notified || current.state !== 'bound' || current.run_id !== request!.run_id || currentRun?.status !== 'active'
        ) return 'terminal';
      if (currentState?.delivery_id !== state.delivery_id) return 'stale';
      const latestReport = taskAssuranceReport(db, current.run_id!, false);
      if (latestReport.pending.length || latestReport.stale.length) return 'review';
      const prior = db.prepare('SELECT input_digest FROM codex_hook_tools WHERE identity_digest = ? AND call_id = ?').get<{ input_digest: string }>(identity, input.tool_use_id!);
      if (prior) return prior.input_digest === inputDigest ? 'accepted' : 'conflict';
      db.prepare('UPDATE task_assurance SET observed_state_digest=COALESCE(observed_state_digest,?) WHERE run_id=?').run(stateDigest,current.run_id);
      db.prepare('INSERT INTO codex_hook_tools(identity_digest, call_id, run_id, delivery_id, input_digest, state_digest, evidence_id) VALUES (?, ?, ?, ?, ?, ?, NULL)')
        .run(identity, input.tool_use_id!, request!.run_id, state.delivery_id, inputDigest, stateDigest);
      return 'accepted';
    });
    if (admission === 'review' || admission === 'stale') return recoverableDeny('Task state changed before tool admission; inspect current status.', 'state_changed');
    if (admission === 'terminal') return denyTurn('Client binding became terminal before tool admission', 'run_terminal');
    if (admission === 'conflict') return denyTurn('Tool call identity was reused with different input', 'call_id_reused');
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
    const contract = record(record(result.assurance).contract);
    const compatible = contract.id === INTEGRATION_CONTRACT.id && contract.version === INTEGRATION_CONTRACT.version;
    const admitted = compatible && ['proceed', 'review_memory_application', 'refresh_memory'].includes(String(result.nextAction));
    const updated = db.prepare('UPDATE codex_hook_requests SET run_id=?,state=? WHERE identity_digest=? AND stop_notified=0 RETURNING identity_digest')
      .get(successor, admitted ? 'bound' : 'pending', identity);
    if (!updated) return stopTurn('PostToolUse');
    if (!compatible) return context('PostToolUse', 'Integration contract mismatch after recovery: ordinary execution remains blocked; inspect and reload matching MCP and hook components.');
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
    const contract = record(record(result.assurance).contract);
    const compatible = contract.id === INTEGRATION_CONTRACT.id && contract.version === INTEGRATION_CONTRACT.version;
    const prepared = compatible && ['proceed', 'review_memory_application', 'refresh_memory'].includes(String(result.nextAction));
    const updated = db.prepare('UPDATE codex_hook_requests SET run_id = ?, state = ? WHERE identity_digest = ? AND stop_notified=0 RETURNING identity_digest').get(runId, prepared ? 'bound' : 'pending', identity);
    if (!updated) return stopTurn('PostToolUse');
    if (!compatible) return context('PostToolUse', 'Integration contract mismatch: ordinary execution remains blocked. Inspect the loaded MCP and hook contract versions, reload matching components, and prepare a new request. Diagnosis and bounded inspection remain available.');
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
    if (current?.stop_notified) return stopTurn('PostToolUse');
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
        db.prepare('UPDATE task_assurance SET observed_changes=1, observed_state_digest=?, revision=revision+1 WHERE run_id=? AND observed_state_digest IS NOT ?').run(digest,current.run_id,digest);
        db.prepare('UPDATE task_assurance SET observation_sequence=observation_sequence+1 WHERE run_id=?').run(current.run_id);
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
    db.prepare('UPDATE task_assurance SET observation_sequence=observation_sequence+1 WHERE run_id=?').run(current.run_id);
    if (outcome === 'unknown') return {};
    return context('PostToolUse', `Execution evidence: ${evidenceId}; outcome: ${outcome}.${outcome === 'passed' && (taskAssuranceReport(db, current.run_id!).missingVerification.length || taskAssuranceReport(db, current.run_id!).verification.checks.some(check => check.status !== 'passed')) ? ' Link it to the unresolved verification requirement.' : ''}`);
  });
}

/** Record protocol shape and decision only, never arguments or tool output. */
export function handleCodexHook(db: SqliteDatabase, raw: unknown): object {
  const input = parseAssurance(hookSchema, raw);
  const response = record(input.tool_response);
  const args = record(input.tool_input);
  const shape = { hasArguments: !!args.arguments, hasParameters: !!args.parameters, hasRequestId: !!args.requestId, hasSoulRead: !!args.soulRead, type: typeof input.tool_response, structured: !!response.structuredContent,
    content: Array.isArray(response.content), exitCode: typeof response.exit_code, exitMetadata: observedExitCode(input.tool_response) === null ? 'unavailable' : 'structured', exitAdapter: CODEX_EXECUTION_ADAPTER.id, contractVersion: INTEGRATION_CONTRACT.version, contractId: INTEGRATION_CONTRACT.id, hookPackageVersion: PACKAGE_VERSION, status: typeof response.status };
  const save = (decision: string, reason?: string, recovery?: Record<string, unknown>) => withImmediateTransaction(db, () => {
    const diagnostic = { ...shape, reason, recoverable: recovery?.recoverable, nextAction: recovery?.nextAction, call: codexHookCorrelationId(input) };
    db.prepare('INSERT INTO codex_hook_observations VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), input.hook_event_name, input.tool_name ?? null, JSON.stringify(diagnostic), decision, new Date().toISOString());
    db.prepare('DELETE FROM codex_hook_observations WHERE rowid NOT IN (SELECT rowid FROM codex_hook_observations ORDER BY rowid DESC LIMIT 1000)').run();
  });
  try {
    const result = handleCodexHookEvent(db, input);
    const specific = record(record(result).hookSpecificOutput);
    try { save(specific.permissionDecision === 'deny' ? 'denied' : 'handled', specific.permissionDecision === 'deny' ? String(record(record(result).kiokukoDecision).reason ?? 'policy_denied') : undefined, record(record(result).kiokukoDecision)); }
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
