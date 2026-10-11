// Opt-in real client acceptance. Uses only a disposable repository and installed package.
// This measures calls, run creation and answers, never private reasoning depth.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const packageRoot = path.resolve(process.argv[2] ?? '.');
const load = name => import(pathToFileURL(path.join(packageRoot, 'dist', name + '.js')));
const { setupGlobalClients } = await load('commands/setup');
const { useRepository } = await load('commands/use');
const { openConnection } = await load('db/connection');
const { getGlobalDatabasePath } = await load('config/paths');
const base = mkdtempSync(path.join(tmpdir(), 'kiokuko-effort-consumer-'));
const root = path.join(base, 'repo'); mkdirSync(root);
const home = path.join(base, 'home'); mkdirSync(home);
const data = path.join(base, 'data');
const cli = path.join(packageRoot, 'dist/bin/kiokuko.js');
const env = { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), KIOKUKO_DATA_DIR: data };
const databasePath = getGlobalDatabasePath({ env });
const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
git('init', '-q'); writeFileSync(path.join(root, 'source.txt'), 'previous value\n');
git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
await setupGlobalClients({ clients: ['codex'], env, databasePath, command: cli });
await useRepository({ root, databasePath });
const generated = readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
assert.match(generated, /zero preparation, memory, or verification calls/u);
const soul = readFileSync(path.join(home, '.agents/skills/kiokuko-codex-soul/SKILL.md'), 'utf8');
assert.match(soul, /No minimum reasoning duration/u);
writeFileSync(path.join(root, 'AGENTS.md'), 'Work only in this disposable repository. Do not read other chats, personal files or parent directories.\n' + generated);
const hooks = JSON.parse(readFileSync(path.join(home, '.codex/hooks.json'), 'utf8')).hooks;
const config = { 'features.hooks': true, 'features.multi_agent': false, 'features.plugins': false,
  'features.apps': false, 'memories.use_memories': false, 'features.memories': false, web_search: 'disabled',
  'mcp_servers.kiokuko.command': process.execPath, 'mcp_servers.kiokuko.args': [cli, 'mcp'],
  'mcp_servers.kiokuko.env': { KIOKUKO_DATA_DIR: data, KIOKUKO_SKILL_DISCOVERY: 'off', KIOKUKO_EMBEDDINGS: 'off', KIOKUKO_HANDOFF: 'off' },
  'mcp_servers.kiokuko.required': true };
for (const [event, groups] of Object.entries(hooks)) config[`hooks.${event}`] = groups;
for (const tool of ['task_inspect', 'task_prepare', 'task_answer', 'task_memory_status', 'memory_recall', 'memory_capture'])
  config[`mcp_servers.kiokuko.tools.${tool}.approval_mode`] = 'approve';
const toml = value => value && typeof value === 'object' && !Array.isArray(value)
  ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`
  : Array.isArray(value) ? `[${value.map(toml).join(',')}]` : JSON.stringify(value);
const scenarios = [
  { id: 'draft', prompt: '変更内容は「指示ファイルの作成前にユーザーへ確認する」です。英語の Conventional Commit 件名を一つ書いて。', answer: /^(?:fix|feat)(?:\([^)]*\))?:.*(?:ask|confirm|prompt)/iu },
  { id: 'translation', prompt: '英訳して: ファイルは確認後に作成します。', answer: /(?:file.*(?:confirm|approv)|(?:confirm|approv).*file)/iu },
  { id: 'results', prompt: '検証結果: 5件成功、0件失敗。これを一文で説明して。', answer: /5.*(?:成功|pass)|(?:all|全).*5/iu },
  { id: 'correction', prompt: '訂正: 自動再作成ではなく、作成するか先に聞く。修正後の方針を一文で返して。', answer: /(?:確認|聞|ask|confirm)/iu },
  { id: 'staged', prompt: 'staged 差分から英語の Conventional Commit 件名を一つ書いて。', answer: /(?:fix|feat|chore|refactor)(?:\([^)]*\))?:/u, diff: true },
];
async function run(prompt) {
  const args = ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--dangerously-bypass-hook-trust', '-s', 'read-only', '-C', root,
    '-c', `projects.${JSON.stringify(root)}.trust_level="trusted"`,
    ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]), '--json', prompt];
  return new Promise(resolve => {
    const child = spawn('codex', args, { cwd: root, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', bytes = 0, failure;
    const kill = signal => { try { process.platform === 'win32' ? child.kill(signal) : process.kill(-child.pid, signal); } catch {} };
    let hardStop;
    const stop = reason => { failure ??= reason; kill('SIGTERM'); hardStop ??= setTimeout(() => kill('SIGKILL'), 2000); };
    const deadline = setTimeout(() => stop('client_timeout'), 120000);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) stop('output_limit'); else stdout += chunk; });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) stop('output_limit'); });
    child.on('error', error => { failure = error.code ?? 'spawn_failed'; });
    child.on('close', code => {
      clearTimeout(deadline); clearTimeout(hardStop); kill('SIGKILL');
      try {
        const events = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
        const items = events.filter(event => event.type === 'item.completed').map(event => event.item);
        const calls = items.filter(item => ['mcp_tool_call', 'command_execution', 'web_search', 'file_change'].includes(item?.type));
        resolve({ code, failure, calls, answer: items.filter(item => item?.type === 'agent_message').at(-1)?.text ?? '', completed: events.some(event => event.type === 'turn.completed') });
      } catch { resolve({ code, failure: 'invalid_client_events', calls: [], answer: '', completed: false }); }
    });
  });
}
const results = [];
for (const scenario of scenarios) {
  if (scenario.diff) { writeFileSync(path.join(root, 'source.txt'), 'updated value\n'); git('add', 'source.txt'); }
  const before = openConnection(databasePath, { readOnly: true });
  const observationCount = before.prepare('SELECT count(*) AS count FROM codex_hook_observations').get().count; before.close();
  const result = await run(scenario.prompt);
  const db = openConnection(databasePath, { readOnly: true });
  const runCount = db.prepare('SELECT count(*) AS count FROM ledger_runs').get().count;
  const observations = db.prepare('SELECT event_name, tool_name FROM codex_hook_observations ORDER BY rowid LIMIT -1 OFFSET ?').all(observationCount);
  db.close();
  const expectedCalls = scenario.diff ? result.calls.length === 1 && result.calls[0].type === 'mcp_tool_call'
    && result.calls[0].tool === 'task_inspect' && result.calls[0].arguments?.operation === 'diff' : result.calls.length === 0;
  const passed = result.code === 0 && result.completed && !result.failure && expectedCalls && runCount === 0 && scenario.answer.test(result.answer)
    && observations.some(row => row.event_name === 'UserPromptSubmit') && observations.some(row => row.event_name === 'Stop');
  const record = { id: scenario.id, passed, exitCode: result.code, failure: result.failure, calls: result.calls.map(call => ({ type: call.type, tool: call.tool, arguments: call.arguments })), runCount, answer: result.answer.slice(0, 1000) };
  results.push(record); console.log(JSON.stringify(record));
  if (!passed) break; // Fail closed without repeatedly spending model calls.
}
// Exercise the normal update on existing managed files, then preserve user deletion.
const update = await setupGlobalClients({ clients: ['codex'], env, databasePath, command: cli });
assert.equal(readFileSync(path.join(root, 'AGENTS.md'), 'utf8').startsWith('Work only in this disposable repository.'), true);
unlinkSync(path.join(root, 'AGENTS.md')); unlinkSync(path.join(home, '.codex/AGENTS.md'));
const preserved = await setupGlobalClients({ clients: ['codex'], env, databasePath, command: cli });
assert.equal(existsSync(path.join(root, 'AGENTS.md')), false); assert.equal(existsSync(path.join(home, '.codex/AGENTS.md')), false);
assert.ok(preserved.projectAgentFiles.some(project => project.reason === 'missing_agent_file'));
const passed = results.length === scenarios.length && results.every(result => result.passed);
writeFileSync(path.join(base, 'results.json'), JSON.stringify({ passed, results, updateFiles: update.files.length, deletedPreserved: true }, null, 2));
console.log(JSON.stringify({ passed, evidenceDirectory: base, client: 'codex-cli', desktop: 'not_tested', deletedPreserved: true }));
process.exitCode = passed ? 0 : 1;
