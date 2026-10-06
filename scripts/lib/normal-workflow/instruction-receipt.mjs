import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Inspect only this attempt's newly created CODEX_HOME. Never inspect another
 * client profile or archive raw rollouts (which may include private reasoning).
 * Missing or unfamiliar client records are an unobserved load, not a pass.
 */
export function collectInstructionReceipt({ codeHome, cwd, clientVersion, threadId, agents, request }) {
  const unobserved = { observed: false, reason: 'instruction_load_unobserved' };
  if (!threadId || !agents.trim()) return unobserved;
  try {
    const sessions = path.join(codeHome, 'sessions');
    if (!existsSync(sessions)) return unobserved;
    const files = [];
    let entries = 0, bytes = 0;
    const visit = (directory, depth = 0) => {
      if (depth > 4 || lstatSync(directory).isSymbolicLink()) throw new Error('Session boundary');
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (++entries > 64 || entry.isSymbolicLink()) throw new Error('Session boundary');
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file, depth + 1);
        else if (entry.isFile() && /^(?:rollout|session)-.*\.jsonl$/u.test(entry.name)) {
          bytes += lstatSync(file).size;
          if (bytes > 16 * 1024 * 1024) throw new Error('Session size limit');
          files.push(file);
        }
      }
    };
    visit(sessions);
    const receipts = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (!text.endsWith('\n')) return unobserved;
      const records = text.trim().split('\n').map(line => JSON.parse(line));
      const metadata = records[0];
      if (metadata?.type !== 'session_meta' || metadata.payload?.id !== threadId) continue;
      if (metadata.payload.cli_version !== clientVersion || realpathSync(metadata.payload.cwd) !== realpathSync(cwd)) return unobserved;
      let instructionIndex = -1, promptIndex = -1;
      for (const [index, record] of records.entries()) {
        const item = record.type === 'response_item' ? record.payload : null;
        if (item?.type === 'message' && item.role === 'user') {
          const parts = Array.isArray(item.content) ? item.content.filter(part => part.type === 'input_text').map(part => part.text) : [];
          if (parts.includes(request)) { promptIndex = index; break; }
          for (const part of parts) {
            const match = /^# AGENTS\.md instructions(?: for [^\n]+)?\n+<INSTRUCTIONS>\n([\s\S]*)\n?<\/INSTRUCTIONS>(?:\n|$)/u.exec(part);
            if (match?.[1].trim() === agents.trim()) instructionIndex = index;
          }
        }
        // A quote in a tool result or model answer cannot prove initial loading.
        if (item?.type === 'function_call' || (item?.type === 'message' && item.role === 'assistant')) break;
      }
      if (instructionIndex < 1 || promptIndex <= instructionIndex) return unobserved;
      const contexts = records.filter(record => record.type === 'turn_context').map(record => record.payload);
      const models = new Set(contexts.flatMap(context => [context?.model,context?.collaboration_mode?.settings?.model]).filter(model => typeof model === 'string'));
      const efforts = new Set(contexts.flatMap(context => [context?.effort,context?.collaboration_mode?.settings?.reasoning_effort]).filter(effort => typeof effort === 'string'));
      const nativeReadonlyObserved=contexts.length>0 && contexts.every(context=>context.sandbox_policy?.type==='read-only' && context.approval_policy==='never');
      receipts.push({ nativeReadonlyObserved, model:models.size === 1 ? [...models][0] : null, effort:efforts.size === 1 ? [...efforts][0] : null,
        modelObserved:models.size === 1, clientVersion:metadata.payload.cli_version, observed: true, schema: 'codex-rollout/user-instructions-v1', threadId,
        source: path.relative(codeHome, file), record: instructionIndex,
        contentHash: createHash('sha256').update(agents).digest('hex') });
    }
    return receipts.length === 1 ? receipts[0] : unobserved;
  } catch { return unobserved; }
}


/** Reconcile the isolated loader receipt with the original complete client
 * stream. Summary counters and a replacement answer are not execution proof. */
export function clientEvidenceErrors(execution, answer, loader) {
  const errors = [], events = execution?.events;
  if (!Array.isArray(events) || !events.length) return ['Raw client events missing'];
  let previous = 0, active = false, turns = 0, threadId, lastAnswer = '', complete = 0;
  const calls = new Set(), started = new Set(), completed = new Set();
  for (const event of events) {
    if (!event || !Number.isSafeInteger(event.sequence) || event.sequence <= previous) {
      errors.push('Client event order invalid'); continue;
    }
    previous = event.sequence;
    if (event.type === 'thread.started') {
      if (threadId || turns || typeof event.thread_id !== 'string' || !event.thread_id) errors.push('Client thread identity invalid');
      threadId = event.thread_id;
    } else if (event.type === 'turn.started') {
      if (!threadId || active) errors.push('Client turn start invalid');
      active = true; turns++;
    } else if (event.type === 'turn.completed') {
      if (!active || [...started].some(id => !completed.has(id))) errors.push('Incomplete client turn');
      active = false; complete++;
    } else if (['item.started','item.updated','item.completed'].includes(event.type)) {
      const item = event.item;
      if (!active || typeof item?.id !== 'string' || !item.id || typeof item.type !== 'string') {
        errors.push('Client item identity or turn invalid'); continue;
      }
      if (event.type === 'item.started') {
        if (started.has(item.id) || completed.has(item.id)) errors.push('Duplicate client item');
        started.add(item.id);
      }
      if (event.type === 'item.completed') {
        if (completed.has(item.id)) errors.push('Duplicate client item completion');
        completed.add(item.id);
        if (item.type === 'agent_message') {
          if (typeof item.text !== 'string') errors.push('Client answer missing');
          else lastAnswer = item.text;
        }
      }
      if (item.type !== 'agent_message' && event.type !== 'item.updated') calls.add(item.id);
    } else errors.push('Failed or unsupported client event');
  }
  if (!threadId || active || !turns || turns !== complete || [...started].some(id => !completed.has(id))) errors.push('Client execution is unfinished');
  if (calls.size !== execution.calls || turns !== execution.turns) errors.push('Raw client resource counts differ');
  const start = Date.parse(execution.started), end = Date.parse(execution.ended);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || execution.seconds !== (end - start) / 1000)
    errors.push('Raw client runtime differs');
  if (typeof answer !== 'string' || answer !== lastAnswer) errors.push('Answer differs from original client output');
  if (loader?.schema !== 'codex-rollout/user-instructions-v1' || loader.observed !== true || loader.threadId !== threadId
    || loader.clientVersion !== execution.clientVersion || loader.modelObserved !== true || loader.model !== execution.model
    || loader.effort !== execution.reasoningEffort) errors.push('Loader receipt differs from original client identity');
  return errors;
}
