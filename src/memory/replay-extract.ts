import { createHash } from 'node:crypto';
import { readReplayBlob } from './replay-blob.js';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { findSecret, findSecretInValue } from './secrets.js';
import { compatibleReplayEvent, declaredReplaySchema } from './replay-contract.js';
import type { ReplayMemoryProposal } from './replay-review.js';
import { extractCodexWireExperience, type ReplaySourceEvent } from './replay-codex-wire.js';
import { validateUserTurnReceipt, verifyReceiptRecording, type ExpectedUserTurn } from '../agenticreplay/turn-receipt.js';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** Shared receipt entry point is deliberately separate from Codex transcript
 * verification. No ChatGPT wire format has been provided by AgenticReplay yet.
 * A valid receipt alone must never fall through to generic/Codex extraction. */
export async function extractTurnReceiptProposal(input: {
  cwd: string; receipt: unknown; expected: ExpectedUserTurn;
}): Promise<ReplayMemoryProposal> {
  const receipt = validateUserTurnReceipt(input.receipt, input.expected);
  await verifyReceiptRecording(input.cwd, receipt);
  throw new Error(receipt.source === 'chatgpt-host' ? 'chatgpt_adapter_unsupported' : 'codex_transcript_required');
}
function codexRequestMatches(headers: unknown, sessionId: string, turnId: string): boolean {
  const fields = object(headers);
  const value = fields['x-codex-turn-metadata'];
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const metadata = object(JSON.parse(value));
    return (metadata.thread_id ?? metadata.session_id) === sessionId && metadata.turn_id === turnId
      && (fields['thread-id'] === undefined || fields['thread-id'] === sessionId);
  } catch {
    return false;
  }
}
const safe = (v: unknown, n = 2048): string => {
  if (typeof v !== 'string') return '';
  // Redact the whole bounded field when a secret is present; truncation never hides a credential suffix.
  if (findSecret(v)) return '[redacted secret-bearing field]';
  return v.replace(/[\p{Cc}\p{Cf}]/gu, character => character === '\n' || character === '\t' ? character : ' ').slice(0, n);
};
async function bounded(file: string, root: string, max: number): Promise<Buffer> {
  const canonical = await realpath(file);
  if (!canonical.startsWith(root + path.sep)) throw new Error('replay_scope_mismatch');
  const info = await stat(canonical);
  if (!info.isFile() || info.size > max) throw new Error('replay_source_bound');
  const bytes = await readFile(canonical);
  if (bytes.length > max) throw new Error('replay_source_bound');
  return bytes;
}
/** Read only explicit user messages and public call/result fields, never reasoning or system prompts. */
export async function extractReplayProposal(input: { cwd: string; traceDirectory: string; taskId: string; sessionId: string; workspace: string; desktopTurnId?: string; desktopUserTextDigests?: string[]; expectedEventsSha256?: string }): Promise<ReplayMemoryProposal> {
  const root = await realpath(input.cwd), directory = await realpath(input.traceDirectory);
  const runs = await realpath(path.join(root, '.agenticreplay', 'runs'));
  if (!runs.startsWith(root + path.sep) || !directory.startsWith(runs + path.sep)) throw new Error('replay_scope_mismatch');
  const manifest = object(JSON.parse((await bounded(path.join(directory, 'manifest.json'), directory, 65536)).toString('utf8')));
  if (!declaredReplaySchema(manifest.schema_version) || typeof manifest.run_id !== 'string' || !/^run_[0-9a-f]{6,32}$/u.test(manifest.run_id)
    || typeof manifest.cwd !== 'string' || await realpath(manifest.cwd) !== root) throw new Error('replay_contract_mismatch');
  const candidates: Buffer[] = [];
  for (const name of ['events.jsonl', 'event.jsonl']) {
    try { candidates.push(await bounded(path.join(directory, name), directory, 8 * 1024 * 1024)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (candidates.length !== 1) throw new Error('replay_event_file_ambiguous_or_missing');
  const bytes = candidates[0]!, digest = hash(bytes), integrity = object(manifest.integrity);
  if (input.expectedEventsSha256 !== undefined && digest !== input.expectedEventsSha256) throw new Error('replay_integrity_mismatch');
  if (integrity.events_sha256 !== undefined && integrity.events_sha256 !== digest) throw new Error('replay_integrity_mismatch');
  const gaps: string[] = input.desktopTurnId === undefined
    ? ['whole selected replay run; task/session labels supplied by the reviewer, not verified by the trace', ...(integrity.events_sha256 ? [] : ['unsealed trace; completeness is unknown'])]
    : ['one verified Codex desktop turn from AgenticReplay API traffic'];
  const events: ReplaySourceEvent[] = [];
  let sequence = -1, blobBytes = 0;
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    if (events.length >= 10000) throw new Error('replay_event_bound');
    const raw = object(JSON.parse(line));
    if (!compatibleReplayEvent(raw) || Number(raw.seq) <= sequence) throw new Error('replay_event_invalid');
    if (events.length === 0 && input.desktopTurnId !== undefined) {
      const attrs = object(raw.attrs);
      if (object(manifest.adapter).id !== 'codex-desktop-api' || object(manifest.capture).status !== 'complete'
        || integrity.events_sha256 !== digest || raw.seq !== 0 || raw.type !== 'run.start' || attrs.source !== 'codex-desktop-api'
        || attrs.sessionId !== input.sessionId || attrs.turnId !== input.desktopTurnId) {
        throw new Error('replay_desktop_turn_mismatch');
      }
    }
    sequence = Number(raw.seq);
    let payload = raw.payload;
    const envelope = object(payload);
    let payloadHash = hash(JSON.stringify(typeof payload === 'string' ? payload : envelope));
    if ('$blob' in envelope) {
      const match = typeof envelope.$blob === 'string' && /^sha256:([a-f0-9]{64})$/u.exec(envelope.$blob);
      if (!match || !Number.isSafeInteger(envelope.bytes) || Number(envelope.bytes) < 0) throw new Error('replay_blob_invalid');
      const data = await readReplayBlob(directory, match[1]!, Number(envelope.bytes), 32 * 1024 * 1024 - blobBytes);
      blobBytes += data.length;
      payloadHash = match[1]!; payload = JSON.parse(data.toString('utf8'));
    }
    if (raw.type === 'model.request' && typeof payload === 'string') payload = JSON.parse(payload);
    events.push({ raw, payload: object(payload), ...(raw.type === 'model.response' && typeof payload === 'string' ? { responseText: payload } : {}), ref: `${manifest.run_id}:${sequence}`, payloadHash });
  }
  if (input.desktopTurnId !== undefined) {
    const requests = new Map<unknown, unknown>();
    for (const { raw } of events.filter(event => event.raw.type === 'net.request')) {
      const request = object(raw.attrs);
      if (typeof request.request_id !== 'string' || requests.has(request.request_id)
        || !codexRequestMatches(request.headers, input.sessionId, input.desktopTurnId)) {
        throw new Error('replay_desktop_turn_mismatch');
      }
      requests.set(request.request_id, raw.seq);
    }
    const responses = events.filter(event => event.raw.type === 'net.response');
    const models = events.filter(event => event.raw.type === 'model.request');
    const coveredResponses = new Set(responses.flatMap(({ raw }) => {
      const response = object(raw.attrs);
      return response.response_complete === true && response.capture_incomplete === false
        && Array.isArray(raw.causes) && requests.has(response.request_id)
        && raw.causes.includes(requests.get(response.request_id)) ? [response.request_id] : [];
    }));
    if (events.at(-1)?.raw.type !== 'run.end'
      || !requests.size || responses.length !== requests.size || coveredResponses.size !== requests.size
      || !models.length || models.some(({ raw }) => !requests.has(object(raw.attrs).request_id))) {
      throw new Error('replay_desktop_turn_mismatch');
    }
  }
  const requestTexts = new Map<string, string>();
  let omittedRequestMessages = 0, truncatedRequestText = false;
  const requestExcerpt = (text: string, limit: number): string => {
    if (text.length <= limit) return text;
    truncatedRequestText = true;
    const marker = '\n[... request text omitted ...]\n';
    const head = Math.floor(limit / 4);
    return text.slice(0, head) + marker + text.slice(-(limit - head - marker.length));
  };
  const rememberRequest = (content: unknown, ref: string): void => {
    if (typeof content !== 'string') return;
    // Scan the full field for secrets before retaining bounded beginning/end excerpts.
    const text = requestExcerpt(safe(content, content.length), 2048);
    if (!text) return;
    requestTexts.delete(text);
    requestTexts.set(text, ref);
    if (requestTexts.size > 20) {
      requestTexts.delete(requestTexts.keys().next().value!);
      omittedRequestMessages += 1;
    }
  };
  for (const event of events) {
    if (input.desktopTurnId !== undefined) {
      // Responses requests can resend previous turns, even inside a correctly scoped API trace.
      if (event.raw.type !== 'model.request' || !Array.isArray(event.payload.input)) continue;
      for (const message of event.payload.input) {
        const item = object(message);
        if (item.role !== 'user' || !Array.isArray(item.content)) continue;
        const content = item.content.map(part => object(part)).filter(part => part.type === 'input_text')
          .map(part => typeof part.text === 'string' ? part.text : '').join('\n');
        const attributedTurn = object(item.metadata).turn_id;
        if (attributedTurn === input.desktopTurnId || (attributedTurn === undefined && input.desktopUserTextDigests?.includes(hash(content)))) {
          rememberRequest(content, event.ref);
        }
      }
      continue;
    }
    if (event.raw.type === 'user.message') rememberRequest(event.payload.text, event.ref);
    if (event.raw.type !== 'model.request' || !Array.isArray(event.payload.messages)) continue;
    for (const message of event.payload.messages) {
      const m = object(message);
      if (m.role !== 'user') continue;
      const content = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map(p => { const b = object(p); return b.type === 'text' ? b.text : ''; }).filter(v => typeof v === 'string').join('\n') : '';
      rememberRequest(content, event.ref);
    }
  }
  const attempts: ReplayMemoryProposal['attempts'] = [];
  const wire = input.desktopTurnId === undefined ? undefined : extractCodexWireExperience(events, input.taskId, safe);
  if (wire) attempts.push(...wire.attempts);
  for (const call of events.filter(e => e.raw.type === 'tool.call' || e.raw.type === 'shell.call')) {
    if (attempts.length >= 100) { gaps.push('only first 100 calls represented'); break; }
    const attrs = object(call.raw.attrs), identity = attrs.attemptId ?? attrs.callId ?? attrs.tool_use_id;
    if (wire?.attempts.some(attempt => attempt.attemptId === identity)) continue;
    if (typeof attrs.taskId === 'string' && attrs.taskId !== input.taskId) continue;
    const taskId = input.desktopTurnId !== undefined ? input.taskId : typeof attrs.taskId === 'string' ? attrs.taskId : null;
    const calls = events.filter(e => e.raw.type === 'tool.call' || e.raw.type === 'shell.call');
    const sameIdentity = calls.filter(e => {const a=object(e.raw.attrs);return identity!==undefined && (a.attemptId??a.callId??a.tool_use_id)===identity;});
    const matches = events.filter(e => {
      if (!/^(tool|shell)\.result$/u.test(String(e.raw.type)) || Number(e.raw.seq)<=Number(call.raw.seq)) return false;
      const resultAttrs=object(e.raw.attrs), resultIdentity=resultAttrs.attemptId??resultAttrs.callId??resultAttrs.tool_use_id;
      const causes=Array.isArray(e.raw.causes)?e.raw.causes:[];
      const causedCalls=calls.filter(c=>causes.includes(c.raw.seq));
      if(causedCalls.length) return causedCalls.length===1 && causedCalls[0]===call && (identity===undefined||resultIdentity===undefined||identity===resultIdentity);
      // Identity-only association is safe only if it selects one call in the whole trace.
      return identity!==undefined && resultIdentity===identity && sameIdentity.length===1;
    });
    const result = matches.length === 1 ? matches[0] : undefined;
    const ra = object(result?.raw.attrs), rp = result?.payload ?? {};
    const exit = typeof ra.exit_code === 'number' && Number.isSafeInteger(ra.exit_code) ? ra.exit_code : undefined;
    const denied = ra.execution_status === 'denied' || ra.permission_decision === 'deny';
    const execution = denied ? 'denied' : result && exit !== undefined ? 'completed' : ra.execution_status === 'started' ? 'started' : result ? 'unknown' : 'attempted';
    const outcome = denied ? 'unknown' : ra.signal || ra.cancelled === true ? 'cancelled' : exit !== undefined ? exit === 0 ? 'succeeded' : 'failed' : ra.is_error === true ? 'failed' : 'unknown';
    const limitations = [ ...(taskId === null ? ['unassigned session-trace evidence; not verified as belonging to the reviewed task'] : []), ...(result ? [] : [matches.length > 1 ? 'ambiguous results' : 'result missing']), ...(denied ? ['execution was denied; not an executed command failure'] : []), ...(exit === undefined ? ['structured exit metadata unavailable'] : []), 'tool outcome does not establish task success'];
    const content = typeof rp.output === 'string' ? rp.output : typeof rp.stdout === 'string' ? rp.stdout : Array.isArray(rp.content) ? rp.content.map(v => { const b = object(v); return b.type === 'text' ? b.text : ''; }).filter(v => typeof v === 'string').join('\n') : '';
    let argumentsValue: unknown = call.raw.payload === undefined
      ? attrs.input : call.payload.arguments ?? call.payload.input ?? call.payload;
    if (typeof argumentsValue === 'string' && argumentsValue.length <= 65536) { try { argumentsValue=JSON.parse(argumentsValue); } catch { argumentsValue={}; } }
    const argumentsObject=object(argumentsValue);
    const rawCommand=argumentsObject.command ?? argumentsObject.cmd;
    const command = safe(rawCommand);
    if(typeof rawCommand==='string' && rawCommand.length>2048)limitations.push('command excerpt truncated at 2048 characters');
    if(content.length>2048)limitations.push('output excerpt truncated at 2048 characters');
    attempts.push({ taskId, attemptId: safe(identity ?? call.ref, 256), tool: safe(attrs.name ?? 'shell', 100), ...(command ? { command } : {}), callRef: call.ref,
      ...(result ? { resultRef: result.ref } : {}), outcome, execution, ...(exit === undefined ? {} : { exitCode: exit }),
      ...(content ? { outputExcerpt: safe(content) } : {}), payloadHashes: [call.payloadHash, ...(result ? [result.payloadHash] : [])], limitations });
  }
  const languages: ReplayMemoryProposal['languages'] = [];
  for (const [name, pattern] of [['TypeScript', /(?:\.tsx?\b|\btsc\b)/u], ['JavaScript', /(?:\.m?js\b|\bnode\b)/u], ['Python', /(?:\.py\b|\bpython3?\b)/u], ['Rust', /(?:\.rs\b|\bcargo\b)/u]] as const) {
    const refs = attempts.filter(a => pattern.test(a.command ?? '')).map(a => a.callRef);
    if (refs.length) languages.push({ name, basis: 'inferred', evidenceRefs: refs });
  }
  const text = requestExcerpt([...requestTexts.keys()].join('\n'), 4096);
  if (omittedRequestMessages) gaps.push('request messages omitted; only the latest 20 distinct excerpts are retained');
  if (truncatedRequestText) gaps.push('request text truncated; beginning and most recent portions are retained');
  if (text && input.desktopTurnId === undefined) gaps.push('request text from recorded user-role messages; current human identity and exact task binding require review');
  if (!text) gaps.push('user request unavailable');
  if (input.desktopTurnId !== undefined && !text && !attempts.length) throw new Error('replay_desktop_memory_empty');
  const findings: ReplayMemoryProposal['findings'] = attempts.filter(a => a.outcome === 'succeeded' || a.outcome === 'failed').map(a => ({ taskId: a.taskId ?? null, kind: a.outcome === 'succeeded' ? 'worked' : 'failed', text: `${a.tool}: ${a.command ?? 'recorded call'}; tool outcome ${a.outcome}. Task-level effectiveness remains unverified.`, basis: 'observed', evidenceRefs: [a.callRef, ...(a.resultRef ? [a.resultRef] : [])] }));
  findings.unshift(...(wire?.findings ?? []));
  const proposal: ReplayMemoryProposal = { schemaVersion: 1, proposalId: '', revision: 1, source: { workspace: input.workspace, taskId: input.taskId, sessionId: input.sessionId, ...(input.desktopTurnId === undefined ? {} : { turnId: input.desktopTurnId }),
    traces: [{ runId: manifest.run_id, eventsSha256: digest, eventsRead: events.length, totalEvents: integrity.events_sha256 ? events.length : null, digestScope: 'complete', complete: gaps.length === 0, gaps }] }, request: { text, evidenceRefs: [...new Set(requestTexts.values())] }, languages, attempts, findings,
    tags: ['agenticreplay', ...languages.map(l => l.name.toLowerCase())], keywords: [...new Set((text + ' ' + findings.map(f => f.text).join(' ') + ' ' + attempts.map(a => `${a.command ?? a.tool} ${a.outputExcerpt ?? ''}`).join(' ')).toLowerCase().match(/[\p{L}\p{N}_.-]{2,64}/gu) ?? [])].slice(0, 64) };
  if (findSecretInValue(proposal)) throw new Error('unsafe_extraction');
  return proposal;
}
