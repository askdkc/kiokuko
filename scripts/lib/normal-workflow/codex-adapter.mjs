import { collectExecutorReceipts } from './executor-receipt.mjs';
import { FIXTURE_ENVIRONMENT_INSTRUCTIONS } from './contracts.mjs';
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** These two stdio servers operate only on controller-owned synthetic data.
 * Native tools stay read-only and cannot escalate. Unknown MCP tools are not
 * exposed; approval applies to this explicit list, never to a whole server. */
export function isolatedMcpPolicy() {
  const tools={kiokuko:['task_prepare','task_prepare_recover','task_answer','task_inspect',
    'task_memory_review','task_execution_evidence','task_memory_refresh','task_verification_define',
    'task_verification_record','task_memory_status','curator_check','memory_recall','memory_capture',
    'memory_derive_lesson','memory_checkpoint'],fixture_executor:['list_files','read_file','write_file','run_command']};
  const config={approval_policy:'never','agents.enabled':false,'features.multi_agent':false,'features.multi_agent_v2':false,
    developer_instructions:FIXTURE_ENVIRONMENT_INSTRUCTIONS};
  for(const [server,names] of Object.entries(tools)) {
    config[`mcp_servers.${server}.enabled_tools`]=names;
    config[`mcp_servers.${server}.default_tools_approval_mode`]='prompt';
    for(const name of names) config[`mcp_servers.${server}.tools.${name}.approval_mode`]='approve';
  }
  return config;
}

// Only a complete standalone fixture-test command can supply execution evidence.
// Logs that merely mention a command, shell branches or arbitrary wrappers do not.
export function fixtureTestCommand(command) {
  if (typeof command !== 'string') return false;
  let text = command.trim();
  const shell = /^\/bin\/(?:sh|bash|zsh) -lc (['"])([^'"\n]+)\1$/u.exec(text);
  if (shell) text = shell[2];
  return /^(?:npm (?:run )?test|node --test(?: test\/(?:[A-Za-z0-9_.-]+|\*)\.test\.mjs)*)$/u.test(text);
}

/** Capture client events only; they cannot establish execution-bound TDD order.
 * A single command that edits tests and implementation provides no Red snapshot.
 * Unknown client event shapes fail closed rather than infer execution metadata.
 */
export function runCodex({ executable, args, cwd, repo, environment, output, limits, sanitize }) {
  return new Promise(resolve => {
    const child = spawn(executable, args, { cwd, env: environment, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '', stderr = '', bytes = 0, calls = 0, turns = 0, sequence = 0, failure;
    const events = [], checkpoints = [], seenCalls = new Set();
    const kill = signal => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch (error) { if (error.code !== 'ESRCH') failure ??= 'process_cleanup_failed'; }
    };
    let hardStop;
    const stop = reason => { failure ??= reason; kill('SIGTERM'); hardStop ??= setTimeout(() => kill('SIGKILL'), 2000); };
    const deadline = setTimeout(() => stop('time_limit'), limits.maxSeconds * 1000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8 * 1024 * 1024) { stop('output_limit'); return; }
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { stop('malformed_event'); continue; }
        // Private reasoning is neither needed nor retained in acceptance evidence.
        if (/reasoning/u.test(event.item?.type ?? event.type)) continue;
        let record;
        try { record = sanitize({ sequence: ++sequence, time: new Date().toISOString(), ...event }); }
        catch { stop('secret_output'); continue; }
        try { appendFileSync(path.join(output, 'events.jsonl'), JSON.stringify(record) + '\n'); events.push(record); }
        catch { stop('evidence_write_failed'); continue; }
        if (event.type === 'turn.started' && ++turns > limits.maxTurns) stop('turn_limit');
        if (['item.started', 'item.completed'].includes(event.type) && event.item && event.item.type !== 'agent_message') {
          if (typeof event.item.id !== 'string') stop('unsupported_item_identity');
          else if (!seenCalls.has(event.item.id)) { seenCalls.add(event.item.id); if (++calls > limits.maxToolCalls) stop('tool_call_limit'); }
        }
        // Buffered client events do not stop later edits. Never snapshot here.
        // No execution-bound barrier is available in this adapter.

      }
    });
    child.stderr.on('data', chunk => { if (stderr.length + chunk.length > 1024 * 1024) stop('stderr_limit'); else stderr += chunk; });
    child.on('error', error => { failure = error.code === 'ENOENT' ? 'client_unavailable' : 'client_spawn_failed'; });
    child.on('close', (code, signal) => {
      clearTimeout(deadline); clearTimeout(hardStop); kill('SIGKILL');
      if (pending.trim()) failure ??= 'incomplete_event';
      let cleanStderr;
      try { cleanStderr = sanitize(stderr); }
      catch { failure ??= 'secret_output'; cleanStderr = 'Sensitive output suppressed'; }
      const answer = events.filter(event => event.type === 'item.completed' && event.item?.type === 'agent_message').at(-1)?.item.text ?? '';
      try { writeFileSync(path.join(output, 'stderr.txt'), cleanStderr); writeFileSync(path.join(output, 'answer.md'), answer); }
      catch { failure ??= 'evidence_write_failed'; }
      resolve({ checkpointAuthority: 'unavailable', exitCode: code, signal, failure, events, checkpoints, answer,
        logComplete: !failure && events.length > 0, turnCompleted: events.some(event => event.type === 'turn.completed'),
        calls, turns, bytes });
    });
  });
}

/** Bind the trusted serialized executor only after the client's actual native
 * read-only policy has been observed. stdout events are never tree authority. */
export function bindExecutorCheckpoints(session,{directory,nativeReadonlyObserved}) {
  return {...session,...collectExecutorReceipts({directory,nativeReadonlyObserved})};
}
