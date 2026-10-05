import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { INTERACTION_MEMORY_INSTRUCTIONS } from '../../dist/memory/interaction-contract.js';

export function toolData(call) {
  const result = call.result;
  if (result?.structuredContent) return result.structuredContent;
  if (result?.structured_content) return result.structured_content;
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  if (text) { try { return JSON.parse(text); } catch { /* Not a structured response. */ } }
  return result;
}

/** One disposable model session. Test evidence remains outside the model's working directory. */
export async function runLiveSession({ root, output, data, executable, index, ...options }) {
  const name = options.name ?? `conversation-${index + 1}`;
  const cwd = options.cwd ?? path.join(output, name, 'work');
  await mkdir(cwd, { recursive: true });
  for (const skill of ['kiokuko-soul', 'memory-reasoning']) {
    await cp(path.join(root, 'skills', skill), path.join(cwd, 'skills', skill), { recursive: true });
  }
  const instructions = INTERACTION_MEMORY_INSTRUCTIONS + '\nThe exact local kiokuko-soul and memory-reasoning Skills are available at '
    + cwd + '/skills/<name>/SKILL.md. Read them in that order. '
    + 'Never read a database, another conversation, global memory files, personal configuration, or parent directories. '
    + 'Use the configured Kiokuko MCP connection for memory. Do not run other agents or use networking tools. '
    + (options.project
      ? 'This is an isolated Git project. Read only those Skill files and this fixture README. Complete Kiokuko task intake before editing. Edit only README.md. '
        + 'Evaluate each delivered memory against this repository and record the applicability decision. Apply the user request to README and save reusable explicit corrections when appropriate.'
      : 'This is ordinary conversation outside a project. Only read those Skill files. Do not create files. Answer the user normally.');
  const serverEnv = { KIOKUKO_DATA_DIR: data, KIOKUKO_SKILL_DISCOVERY: 'off', KIOKUKO_EMBEDDINGS: 'off',
    KIOKUKO_RERANKER_MODE: 'off', KIOKUKO_HANDOFF: 'off', KIOKUKO_INTERACTION_MEMORY: options.captureOff ? 'off' : 'on' };
  const config = {
    developer_instructions: instructions, project_doc_max_bytes: 0,
    'memories.use_memories': false, 'features.memories': false, 'features.multi_agent': false,
    'features.hooks': false, 'features.plugins': false, 'features.apps': false,
    'web_search': 'disabled',
    'mcp_servers.kiokuko.command': process.execPath,
    'mcp_servers.kiokuko.args': options.fault
      ? [path.join(root, 'scripts/lib/interaction-fault-proxy.mjs'), options.fault, path.join(output, name + '.protocol.jsonl')]
      : [path.join(root, 'dist/bin/kiokuko.js'), 'mcp'],
    'mcp_servers.kiokuko.env': serverEnv, 'mcp_servers.kiokuko.required': true,
  };
  if (process.env.KIOKUKO_SMOKE_MODEL) config.model = process.env.KIOKUKO_SMOKE_MODEL;
  if (process.env.KIOKUKO_SMOKE_REASONING_EFFORT) config.model_reasoning_effort = process.env.KIOKUKO_SMOKE_REASONING_EFFORT;
  if (options.fault === 'response-loss') config['mcp_servers.kiokuko.tool_timeout_sec'] = 10;
  for (const tool of ['task_prepare', 'task_answer', 'task_memory_status', 'task_memory_review', 'task_execution_evidence',
    'task_memory_refresh', 'task_inspect', 'memory_capture', 'memory_checkpoint', 'memory_recall', 'handoff_save', 'curator_check']) {
    config[`mcp_servers.kiokuko.tools.${tool}.approval_mode`] = 'approve';
  }
  const toml = (value) => typeof value === 'object' && !Array.isArray(value)
    ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${JSON.stringify(item)}`).join(',')}}`
    : JSON.stringify(value);
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', options.project ? 'workspace-write' : 'read-only', '--json', '--cd', cwd,
    ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]), options.prompt];
  await writeFile(path.join(output, name + '.input.json'), JSON.stringify({ prompt: options.prompt, cwd, serverEnv,
    fault: options.fault ?? null, project: options.project ?? false,
    toolTimeoutSeconds: config['mcp_servers.kiokuko.tool_timeout_sec'] ?? 'client default',
    model: config.model ?? 'client default (not exposed)', reasoningEffort: config.model_reasoning_effort ?? 'client default (not exposed)' }, null, 2));
  const result = await new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', failure;
    const kill = (signal) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch (error) { if (error.code !== 'ESRCH') failure ??= error.message; }
    };
    let hardStop;
    const stop = (reason) => { failure ??= reason; kill('SIGTERM'); hardStop ??= setTimeout(() => kill('SIGKILL'), 2_000); };
    const deadline = setTimeout(() => stop('session_timeout'), 180_000);
    child.stdout.on('data', (chunk) => { if (stdout.length + chunk.length > 8 * 1024 * 1024) stop('output_limit'); else stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length + chunk.length > 1024 * 1024) stop('stderr_limit'); else stderr += chunk; });
    child.on('error', (error) => { failure = error.code ?? error.message; });
    child.on('close', (code, signal) => {
      clearTimeout(deadline); clearTimeout(hardStop); kill('SIGKILL');
      resolve({ code, signal, stdout, stderr, failure });
    });
  });
  const events = result.stdout.split('\n').filter(Boolean).flatMap((line) => {
    try { const event = JSON.parse(line); return /reasoning/u.test(event.item?.type ?? event.type) ? [] : [event]; }
    catch { return [{ type: 'unparsed_output', text: line }]; }
  });
  await writeFile(path.join(output, name + '.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  await writeFile(path.join(output, name + '.stderr'), result.stderr);
  const calls = events.filter((event) => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call').map((event) => event.item);
  const answer = events.filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message').at(-1)?.item.text ?? '';
  const answerPath = path.join(output, name + '.md');
  await writeFile(answerPath, answer);
  if (result.failure || result.code !== 0) {
    const error = new Error(`Codex session ${name}: ${result.failure ?? result.signal ?? result.code}; inspect ${output}`);
    error.blocked = /authentication|not logged in|failed to connect|network|permission denied|operation not permitted|ENOTFOUND|EAI_AGAIN|requires a newer version of Codex|model.{0,100}(?:not supported|not found|not available)/iu.test(result.stderr + result.stdout);
    throw error;
  }
  assert.ok(answer, `Session ${name} returned no answer`);
  return { calls, answer, events, name, answerPath };
}
