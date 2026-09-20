import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { sanitizeJson } from '../dist/security/sanitize.js';
import { initializeDatabase } from '../dist/commands/init.js';
import { renderCodexAssuranceHooks } from '../dist/setup/codex-hooks.js';
import { openConnection } from '../dist/db/connection.js';

const base = mkdtempSync(path.join(tmpdir(), 'kiokuko-codex-live-'));
const root = path.join(base, 'repo');
execFileSync('git', ['init', '-q', root]);
const databasePath = path.join(base, 'memory.sqlite3');
await initializeDatabase({ databasePath });
const executable = fileURLToPath(new URL('../dist/bin/kiokuko.js', import.meta.url));
mkdirSync(path.join(root, '.codex'));
writeFileSync(path.join(root, '.gitignore'), '.codex/\n');
writeFileSync(path.join(root, '.codex/hooks.json'), renderCodexAssuranceHooks('', executable, databasePath));
// Keep only bounded event metadata from the client. Never save the JSON stream or assistant text.
const args = ['exec', '--ignore-user-config', '--ephemeral', '--dangerously-bypass-hook-trust', '-s', 'workspace-write', '-C', root,
  '-c', `projects.${JSON.stringify(root)}.trust_level="trusted"`,
  '-c', `mcp_servers.kiokuko.command=${JSON.stringify(executable)}`,
  '-c', `mcp_servers.kiokuko.args=["mcp"]`,
  '-c', 'mcp_servers.kiokuko.tools.task_prepare.approval_mode="approve"',
  '-c', 'mcp_servers.kiokuko.tools.task_answer.approval_mode="approve"',
  '-c', 'mcp_servers.kiokuko.tools.task_memory_status.approval_mode="approve"',
  '-c', `mcp_servers.kiokuko.env.KIOKUKO_DATA_DIR=${JSON.stringify(base)}`,
  '-c', 'mcp_servers.kiokuko.env.KIOKUKO_SKILL_DISCOVERY="off"',
  '--json', 'This is an isolated Kiokuko hook integration test. First deliberately try to create probe.txt with apply_patch before preparing; the hook should deny it. Then use task_inspect to read kiokuko-soul/SKILL.md, call task_prepare using the hook request ID, complete any intake, create probe.txt containing ok, run exactly the shell command true, and finish. Work only in this temporary repository. Do not use other tasks or user files.'];
// The database name expected by KIOKUKO_DATA_DIR is fixed by the public path resolver.
const { getGlobalDatabasePath } = await import('../dist/config/paths.js');
const actualDatabase = getGlobalDatabasePath({ env: { ...process.env, KIOKUKO_DATA_DIR: base } });
if (actualDatabase !== databasePath) {
  await initializeDatabase({ databasePath: actualDatabase });
  writeFileSync(path.join(root, '.codex/hooks.json'), renderCodexAssuranceHooks('', executable, actualDatabase));
}
// Inline overrides are an active configuration layer even under --ignore-user-config.
const hookConfig = JSON.parse(renderCodexAssuranceHooks('', executable, actualDatabase));
for (const [event, groups] of Object.entries(hookConfig.hooks)) {
  const command = groups[0].hooks[0].command;
  args.splice(args.length - 1, 0, '-c', `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=30}]}]`);
}
let bytes = 0; let outputEvents = 0; let pending = ""; const toolErrors = [];
const child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'] });
const timeout = setTimeout(() => child.kill('SIGTERM'), 180000);
child.stdout.on('data', chunk => {
  bytes += chunk.length; pending += chunk.toString();
  const lines = pending.split('\n'); pending = lines.pop() ?? '';
  for (const line of lines) {
    outputEvents += 1;
    try {
      const event = JSON.parse(line);
      const error = event.item?.error ?? event.error;
      if (error && toolErrors.length < 8) toolErrors.push(sanitizeJson(JSON.stringify(error).slice(0, 1000)).value);
    } catch {}
  }
});
child.stderr.on('data', () => {});
child.on('error', () => {});
const code = await new Promise(resolve => child.on('close', resolve));
clearTimeout(timeout);
const db = openConnection(actualDatabase);
const requests = db.prepare('SELECT state, last_event, run_id FROM codex_hook_requests').all();
const observations = db.prepare('SELECT event_name, tool_name, response_shape, decision FROM codex_hook_observations').all();
const evidence = db.prepare('SELECT provenance, outcome FROM task_execution_evidence').all();
const protocolChecks = {
  preparationGate: observations.some(o => o.event_name === 'PreToolUse' && o.tool_name === 'apply_patch' && o.decision === 'denied'),
  runBinding: requests.some(r => r.state === 'bound'),
  observedPassingExecution: evidence.some(e => e.provenance === 'client_observed' && e.outcome === 'passed'),
  stop: observations.some(o => o.event_name === 'Stop' && o.decision === 'handled'),
};
const passed = code === 0 && Object.values(protocolChecks).every(Boolean);
const clientVersion = execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim();
const result = { protocolChecks, clientVersion, toolErrors, observations, client: 'codex-cli', passed, exitCode: code, requestCount: requests.length, bound: requests.filter(r => r.run_id).length,
  lastEvents: requests.map(r => r.last_event), evidence, outputEvents, outputBytes: bytes, fixtureDirectory: base, desktop: 'not_tested' };
db.close();
console.log(JSON.stringify(result, null, 2));
process.exitCode = passed ? 0 : 1;
