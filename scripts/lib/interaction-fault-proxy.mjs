// Transparent stdio proxy: real server, untouched requests/results, one explicit
// concurrent write or dropped response. Never fabricate a memory tool response.
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';

const [fault, log] = process.argv.slice(2);
if (!['conflict', 'response-loss'].includes(fault) || !log || !process.env.KIOKUKO_DATA_DIR) throw new Error('Invalid isolated fault proxy arguments');
const child = spawn(process.execPath, [fileURLToPath(new URL('../../dist/bin/kiokuko.js', import.meta.url)), 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
const requests = new Map();
let injected = existsSync(log + '.injected');
const started = performance.now();
const record = (value) => appendFileSync(log, JSON.stringify({ elapsedMs: Math.round(performance.now() - started), ...value }) + '\n');
function receive(stream, onMessage) {
  const buffer = new ReadBuffer({ maxBufferSize: 1024 * 1024 });
  stream.on('data', (chunk) => {
    try {
      buffer.append(chunk);
      for (let message; (message = buffer.readMessage()) !== null;) onMessage(message);
    } catch (error) { record({ event: 'proxy-failed', message: error.message }); child.kill('SIGKILL'); process.exitCode = 1; process.stdin.destroy(); }
  });
}
receive(process.stdin, (message) => {
  if (message.method === 'tools/call') {
    record({ direction: 'request', message });
    requests.set(message.id, message.params);
    const replacement = message.params?.arguments?.memories?.find((memory) => memory.replaces)?.replaces;
    if (!injected && fault === 'conflict' && message.params.name === 'memory_capture' && replacement) {
      const result = execFileSync(process.execPath, [fileURLToPath(new URL('./interaction-conflict-writer.mjs', import.meta.url)), replacement.entryId], { encoding: 'utf8', timeout: 10_000 });
      record({ event: 'concurrent-write', result: JSON.parse(result) });
      writeFileSync(log + '.injected', 'conflict'); injected = true;
    }
  }
  child.stdin.write(serializeMessage(message));
});
receive(child.stdout, (message) => {
  const request = requests.get(message.id);
  if (request) record({ direction: 'response', message });
  if (!injected && fault === 'response-loss' && request?.name === 'memory_capture'
    && message.result?.structuredContent?.enabled === true && !message.result.isError) {
    injected = true; writeFileSync(log + '.injected', 'response-loss');
    record({ event: 'response-dropped', operationId: request.arguments.operationId });
    requests.delete(message.id);
    return; // Actual client timeout, with the connection kept usable for an exact retry.
  }
  requests.delete(message.id);
  process.stdout.write(serializeMessage(message));
});
process.stdin.on('end', () => child.stdin.end());
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); process.stdin.destroy(); });
child.on('error', (error) => { record({ event: 'spawn-failed', message: error.message }); process.exitCode = 1; process.stdin.destroy(); });
child.on('close', (code) => { process.exitCode = code ?? 1; process.stdin.destroy(); });
