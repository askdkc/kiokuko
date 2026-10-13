import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { MemoryObservation } from './observation-contract.js';

/** AgenticReplay directory trace schema 0.4.0. Never read blobs or copy payloads. */
export async function readReplayObservation(input: {
  cwd: string; traceDirectory: string; sessionId: string; kind: 'compaction' | 'completion';
}): Promise<{ observation?: MemoryObservation; warnings: string[] }> {
  try {
    const cwd = await realpath(input.cwd), directory = await realpath(input.traceDirectory);
    const runs = await realpath(path.join(cwd, '.agenticreplay', 'runs'));
    if (!runs.startsWith(cwd + path.sep) || !directory.startsWith(runs + path.sep)) return { warnings: ['replay_scope_mismatch'] };
    const manifestPath = path.join(directory, 'manifest.json');
    const eventsPath = path.join(directory, 'events.jsonl');
    for (const [file, maximum] of [[manifestPath, 64 * 1024], [eventsPath, 2 * 1024 * 1024]] as const) {
      const canonical = await realpath(file);
      const info = await stat(canonical);
      if (!canonical.startsWith(directory + path.sep) || !info.isFile() || info.size > maximum) return { warnings: ['replay_source_bound'] };
    }
    const manifestBytes = await readFile(manifestPath);
    if (manifestBytes.length > 64 * 1024) return { warnings: ['replay_source_bound'] };
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
    if (manifest.schema_version !== '0.4.0' || typeof manifest.run_id !== 'string'
      || !/^run_[0-9a-f]{6,32}$/u.test(manifest.run_id) || typeof manifest.cwd !== 'string'
      || await realpath(manifest.cwd) !== cwd) return { warnings: ['replay_contract_mismatch'] };
    const bytes = await readFile(eventsPath);
    if (bytes.length > 2 * 1024 * 1024) return { warnings: ['replay_source_bound'] };
    const integrity = manifest.integrity as Record<string, unknown> | undefined;
    if (integrity?.events_sha256 !== undefined && integrity.events_sha256 !== createHash('sha256').update(bytes).digest('hex')) {
      return { warnings: ['replay_integrity_mismatch'] };
    }
    const actions: MemoryObservation['actions'] = [], eventIds: string[] = [];
    const kinds = new Map<string, MemoryObservation['actions'][number]['kind']>([
      ['shell.result', 'other'], ['tool.result', 'other'], ['fs.change', 'edit'],
      ['fs.snapshot', 'inspect'], ['retrieval.context', 'inspect'], ['error', 'recover'],
    ]);
    let sequence = -1, count = 0, lastSequence = 0;
    for (const line of bytes.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      if (++count > 10000) return { warnings: ['replay_source_bound'] };
      const event = JSON.parse(line) as Record<string, unknown>;
      if (!Number.isSafeInteger(event.seq) || Number(event.seq) <= sequence || typeof event.type !== 'string') {
        return { warnings: ['replay_event_invalid'] };
      }
      sequence = Number(event.seq); lastSequence = sequence;
      const kind = kinds.get(event.type);
      if (!kind) continue;
      // Raw command, stdout, model response and reasoning are deliberately
      // excluded. Trace metadata is an observation, never a product test.
      const attrs = event.attrs && typeof event.attrs === 'object' && !Array.isArray(event.attrs)
        ? event.attrs as Record<string, unknown> : {};
      const exitCode = typeof attrs.exit_code === 'number' && Number.isSafeInteger(attrs.exit_code) && attrs.signal == null ? attrs.exit_code : undefined;
      const outcome = event.type === 'error' || attrs.is_error === true || (exitCode !== undefined && exitCode !== 0)
        ? 'failed' : exitCode === 0 || attrs.is_error === false ? 'passed' : 'unknown';
      actions.push({ kind, outcome, summary: `Recorded ${event.type}${exitCode === undefined ? '' : ` (exit_code=${exitCode})`}` });
      eventIds.push(`${manifest.run_id}:${sequence}`);
    }
    const sealed = integrity?.events_sha256 !== undefined;
    const observation: MemoryObservation = {
      cwd, eventId: `${manifest.run_id}:${input.kind}`, sessionId: input.sessionId, kind: input.kind,
      summary: `${input.kind === 'compaction' ? 'Context compaction' : 'Coding completion'} signal with ${count} recorded trace events. Product verification is unknown.`,
      tags: ['agenticreplay', 'recorded-actions'], outcome: 'unknown', verification: 'unknown',
      actions: actions.slice(-20),
      source: { producer: 'agenticreplay', runId: manifest.run_id, eventIds: eventIds.slice(-40), revision: lastSequence, tombstone: false },
    };
    return { observation, warnings: sealed ? [] : ['replay_unsealed'] };
  } catch { return { warnings: ['replay_source_unavailable'] }; }
}
