// Live Codex test: fresh sessions, natural user messages, real stdio MCP, isolated DB.
// Uses the CLI's existing login; does not read credentials or rewrite client config.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTERACTION_MEMORY_INSTRUCTIONS } from '../dist/memory/interaction-contract.js';
import { openConnection } from '../dist/db/connection.js';
import { getGlobalDatabasePath } from '../dist/config/paths.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await mkdtemp(path.join(tmpdir(), 'kiokuko-live-interaction-'));
const data = path.join(output, 'data');
console.log(`Evidence directory: ${output}`);
const executable = process.env.KIOKUKO_SMOKE_CODEX ?? 'codex';
const prompts = [
  'For Japanese grammar explanations, I prefer two examples about trains before grammatical terminology.',
  'Explain the difference between は and が in Japanese grammar.',
];

async function runSession(index) {
  const cwd = path.join(output, `conversation-${index + 1}`);
  await mkdir(cwd);
  for (const skill of ['kiokuko-soul', 'memory-reasoning']) {
    await cp(path.join(root, 'skills', skill), path.join(cwd, 'skills', skill), { recursive: true });
  }
  const instructions = `${INTERACTION_MEMORY_INSTRUCTIONS}\nThe exact local kiokuko-soul and memory-reasoning Skills are available at ${cwd}/skills/<name>/SKILL.md. Read them in that order. This is ordinary conversation outside a project. Only read these local Skill files. Never read a database, another conversation, global memory files, personal configuration, or parent directories. Use the configured Kiokuko MCP connection for memory. Do not create files, run other agents, or use networking tools. Answer the user's message normally.`;
  const config = {
    developer_instructions: instructions,
    project_doc_max_bytes: 0,
    'memories.use_memories': false,
    'features.memories': false,
    'features.multi_agent': false,
    'features.hooks': false,
    'features.plugins': false,
    'features.apps': false,
    'mcp_servers.kiokuko.command': process.execPath,
    'mcp_servers.kiokuko.args': [path.join(root, 'dist/bin/kiokuko.js'), 'mcp'],
    'mcp_servers.kiokuko.env': { KIOKUKO_DATA_DIR: data, KIOKUKO_SKILL_DISCOVERY: 'off' },
    'mcp_servers.kiokuko.required': true,
    'mcp_servers.kiokuko.tools.memory_capture.approval_mode': 'approve',
  };
  // Inline TOML values are argv, never shell text.
  const toml = (value) => typeof value === 'object' && !Array.isArray(value)
    ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${JSON.stringify(item)}`).join(',')}}`
    : JSON.stringify(value);
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', 'read-only', '--json', '--cd', cwd,
    ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]), prompts[index]];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const deadline = setTimeout(() => child.kill('SIGTERM'), 180_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => { clearTimeout(deadline); resolve({ code, signal, stdout, stderr }); });
  });
  await writeFile(path.join(output, `conversation-${index + 1}.jsonl`), result.stdout);
  await writeFile(path.join(output, `conversation-${index + 1}.stderr`), result.stderr);
  assert.equal(result.code, 0, `Codex session failed (${result.signal ?? result.code}); inspect ${output}`);
  const events = result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const calls = events.filter((event) => event.type === 'item.completed' && event.item?.type === 'mcp_tool_call').map((event) => event.item);
  const answer = events.filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message').map((event) => event.item.text).join('\n');
  await writeFile(path.join(output, `answer-${index + 1}.md`), answer);
  return { calls, answer };
}

try {
  const first = await runSession(0);
  assert.ok(first.calls.some((call) => call.tool === 'memory_capture' && call.status === 'completed'), 'Model did not capture the preference');
  const second = await runSession(1);
  assert.ok(second.calls.some((call) => call.tool === 'memory_recall' && call.status === 'completed'
    && /train/i.test(JSON.stringify(call.result))), 'Second session did not recall the saved preference');
  assert.match(second.answer, /train|電車|列車|汽車/iu, 'Second answer did not use the recalled train preference');
  const database = openConnection(getGlobalDatabasePath({ env: { KIOKUKO_DATA_DIR: data } }), { readOnly: true });
  try {
    for (const table of ['repository_locations', 'ledger_runs', 'akinator_sessions']) {
      assert.equal(database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, `${table} must stay empty`);
    }
  } finally { database.close(); }
  const summary = { client: 'codex', result: 'passed', naturalPrompts: prompts,
    captureObserved: true, recallObserved: true, trainPreferenceInLaterAnswer: true,
    note: 'Inspect answer-2.md to verify examples precede terminology. Uses a disposable DB and process-only configuration, not installed client configuration.' };
  await writeFile(path.join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
