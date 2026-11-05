import type { ReplayMemoryProposal } from './replay-review.js';

type Fields = Record<string, unknown>;
export interface ReplaySourceEvent {
  raw: Fields; payload: Fields; responseText?: string; ref: string; payloadHash: string;
}
const object = (value: unknown): Fields => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {};

/** Decode a sealed API response, selecting only its completed public output, never reasoning/deltas. */
function completedOutput(event: ReplaySourceEvent): unknown[] {
  const records: Fields[] = [];
  if (event.responseText === undefined) records.push(event.payload);
  else {
    // AgenticReplay stores decoded WebSocket messages in SSE frames. Also accept JSON messages.
    for (const frame of event.responseText.split(/\r?\n\r?\n/u)) {
      if (!frame.trim()) continue;
      const data = frame.trimStart().startsWith('{') ? frame : frame.split(/\r?\n/u)
        .filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      if (records.length >= 20000) throw new Error('replay_desktop_response_bound');
      records.push(object(JSON.parse(data)));
    }
  }
  if (records.some(record => ['error', 'response.failed', 'response.incomplete'].includes(String(record.type)))) throw new Error('replay_desktop_response_incomplete');
  const completed = records.filter(record => record.type === 'response.completed').map(record => object(record.response));
  if (completed.length !== 1 || completed[0]!.status !== 'completed' || !Array.isArray(completed[0]!.output)) throw new Error('replay_desktop_response_invalid');
  return completed[0]!.output;
}

function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.map(object).filter(part => ['input_text', 'output_text', 'text'].includes(String(part.type)))
    .map(part => typeof part.text === 'string' ? part.text : '').join('\n') : '';
}

/** Extract experience from already verified desktop-turn traffic. Does not record or execute anything. */
export function extractCodexWireExperience(events: ReplaySourceEvent[], taskId: string, safe: (value: unknown, limit?: number) => string): {
  attempts: ReplayMemoryProposal['attempts']; findings: ReplayMemoryProposal['findings'];
} {
  const requests = events.filter(event => event.raw.type === 'model.request');
  const responses = events.filter(event => event.raw.type === 'model.response');
  const calls = new Map<string, { item: Fields; event: ReplaySourceEvent }>();
  const finalTexts: Array<{ text: string; event: ReplaySourceEvent }> = [];
  const boundRequests = new Set<ReplaySourceEvent>();
  for (const event of responses) {
    const id = object(event.raw.attrs).request_id;
    const matched = requests.filter(request => typeof id === 'string' && object(request.raw.attrs).request_id === id && Number(request.raw.seq) < Number(event.raw.seq));
    if (matched.length !== 1 || boundRequests.has(matched[0]!)) throw new Error('replay_desktop_response_mismatch');
    boundRequests.add(matched[0]!);
    for (const output of completedOutput(event)) {
      const item = object(output);
      if (['custom_tool_call', 'function_call'].includes(String(item.type))) {
        if (typeof item.call_id !== 'string' || !item.call_id || item.call_id.length > 256 || typeof item.name !== 'string'
          || typeof (item.type === 'custom_tool_call' ? item.input : item.arguments) !== 'string') throw new Error('replay_desktop_call_invalid');
        const prior = calls.get(item.call_id);
        if (prior && JSON.stringify(prior.item) !== JSON.stringify(item)) throw new Error('replay_desktop_call_ambiguous');
        if (!prior) {
          if (calls.size >= 100) throw new Error('replay_desktop_call_bound');
          calls.set(item.call_id, { item, event });
        }
      } else if (item.type === 'message' && item.role === 'assistant' && item.phase === 'final_answer') {
        const text = resultText(item.content);
        if (text) finalTexts.push({ text, event });
      }
    }
  }
  if (responses.length && boundRequests.size !== requests.length) throw new Error('replay_desktop_response_mismatch');
  const attempts: ReplayMemoryProposal['attempts'] = [];
  for (const [id, call] of calls) {
    const results = new Map<string, { text: string; event: ReplaySourceEvent }>();
    for (const request of requests) {
      if (Number(request.raw.seq) <= Number(call.event.raw.seq) || !Array.isArray(request.payload.input)) continue;
      for (const output of request.payload.input) {
        const item = object(output);
        if (item.call_id !== id || item.type !== (call.item.type === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output')) continue;
        if (typeof item.output !== 'string' && !Array.isArray(item.output)) throw new Error('replay_desktop_result_invalid');
        const text = resultText(item.output);
        // Resent history is one result only when the complete original content is identical.
        const identity = JSON.stringify(item.output);
        if (!results.has(identity)) results.set(identity, { text, event: request });
      }
    }
    const result = results.size === 1 ? results.values().next().value : undefined;
    const rawArguments = call.item.type === 'custom_tool_call' ? call.item.input : call.item.arguments;
    const argumentsText = typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments ?? {});
    attempts.push({ taskId, attemptId: safe(id, 256), tool: safe(call.item.name, 100), arguments: safe(argumentsText, 2048),
      callRef: call.event.ref, ...(result ? { resultRef: result.event.ref, outputExcerpt: safe(result.text, 2048) } : {}),
      outcome: 'unknown', execution: result ? 'unknown' : 'attempted',
      payloadHashes: [call.event.payloadHash, ...(result ? [result.event.payloadHash] : [])],
      limitations: [
        ...(results.size === 0 ? ['result missing'] : results.size > 1 ? ['ambiguous results'] : []),
        ...(argumentsText.length > 2048 ? ['arguments excerpt truncated at 2048 characters'] : []),
        ...(result && result.text.length > 2048 ? ['output excerpt truncated at 2048 characters'] : []),
        'structured exit metadata unavailable', 'tool outcome does not establish task success',
      ],
    });
  }
  // The public final answer is a recorded claim, not independent verification of task success.
  const final = finalTexts.at(-1);
  const finalText = final ? safe(final.text, final.text.length).replace(/\s+/gu, ' ').trim() : '';
  const findings: ReplayMemoryProposal['findings'] = final ? [{ taskId, kind: 'key_point', basis: 'inferred',
    text: `Recorded final answer (unverified): ${finalText.slice(0, 240)}${finalText.length > 240 ? ' [… excerpt]' : ''}`,
    evidenceRefs: [final.event.ref] }] : [];
  if (!findings.length) {
    const result = [...attempts].reverse().find(attempt => attempt.outputExcerpt);
    if (result) findings.push({ taskId, kind: 'key_point', basis: 'observed',
      text: `Recorded tool result (task success unverified): ${result.outputExcerpt!.slice(0, 240)}${result.outputExcerpt!.length > 240 ? ' [… excerpt]' : ''}`,
      evidenceRefs: [result.callRef, result.resultRef!] });
  }
  return { attempts, findings };
}
