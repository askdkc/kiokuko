import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'normal';
const delayMs = mode.startsWith('delay-') ? Number(mode.slice('delay-'.length)) : 0;
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
process.stdout.write(`${JSON.stringify({ type: 'ready' })}\n`);

input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.action === 'shutdown') {
    process.stdout.write(`${JSON.stringify({ type: 'shutdown' })}\n`);
    input.close();
    return;
  }
  setTimeout(() => {
    if (mode === 'malformed') {
      process.stdout.write(`${JSON.stringify({ type: 'scores', id: request.id, scores: [{ score: null }] })}\n`);
      return;
    }
    process.stdout.write(`${JSON.stringify({ type: 'scores', id: request.id, scores: request.pairs.map((pair) => ({ score: pair.document.length })) })}\n`);
  }, delayMs);
});
