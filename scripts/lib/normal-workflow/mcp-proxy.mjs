// Transparent packaged MCP boundary. Record discovery and tool results; inject
// only one documented selector error when explicitly selected by the scenario.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { captureSanitizer } from './log-safety.mjs';

const [executable, log, fault = 'none'] = process.argv.slice(2);
if (!executable || !log || !['none', 'selector-once'].includes(fault)) throw new Error('Invalid proxy arguments');
const { sanitizeJson } = await import(pathToFileURL(path.resolve(path.dirname(executable), '../security/sanitize.js')).href);
const imports = executable.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [];
const child = spawn(process.execPath, [...imports, executable, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
let injected = existsSync(`${log}.injected`);
const sanitize = captureSanitizer(sanitizeJson, process.env.KIOKUKO_ACCEPTANCE_AUTH_FILE
  ? JSON.parse(readFileSync(process.env.KIOKUKO_ACCEPTANCE_AUTH_FILE, 'utf8')) : {});
const record = value => appendFileSync(log, JSON.stringify(sanitize({ time: new Date().toISOString(), ...value })) + '\n');
function receive(stream, callback) {
  const buffer = new ReadBuffer({ maxBufferSize: 1024 * 1024 });
  stream.on('data', chunk => {
    try { buffer.append(chunk); for (let value; (value = buffer.readMessage()) !== null;) callback(value); }
    catch { record({ type: 'proxy_error' }); child.kill('SIGKILL'); process.stdin.destroy(); process.exitCode = 1; }
  });
}
receive(process.stdin, message => {
  if (message.method === 'tools/list' || message.method === 'tools/call') record({ direction: 'request', message });
  if (!injected && fault === 'selector-once' && message.method === 'tools/call'
    && message.params?.name === 'task_inspect' && message.params.arguments?.operation === 'skill') {
    injected = true; writeFileSync(`${log}.injected`, 'one injected error');
    record({ type: 'injected_selector', requestId: message.id });
    message = { ...message, params: { ...message.params,
      arguments: { ...message.params.arguments, path: 'skills/unknown-acceptance-skill/SKILL.md' } } };
  }
  child.stdin.write(serializeMessage(message));
});
receive(child.stdout, message => { record({ direction: 'response', message }); process.stdout.write(serializeMessage(message)); });
process.stdin.on('end', () => child.stdin.end());
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); process.stdin.destroy(); });
child.on('error', () => { record({ type: 'spawn_error' }); process.exitCode = 1; process.stdin.destroy(); });
child.on('close', code => { process.exitCode = code ?? 1; process.stdin.destroy(); });
