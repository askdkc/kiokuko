// Supervisor-only result channel. Worker stdout/stderr are log events, never
// parsed as counters. The only entry file is our trusted VM bridge, not a test.
import { run } from 'node:test';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [root, output, ...files] = process.argv.slice(2);
const worker = fileURLToPath(new URL('./test-worker.mjs', import.meta.url));
const results = [], logs = [];
for (const file of files) {
  const events = []; let summary;
  const stream = run({ files: [worker], isolation: 'process', concurrency: 1,
    execArgv: ['--experimental-vm-modules', '--permission', `--allow-fs-read=${root}`, `--allow-fs-read=${worker}`],
    argv: [file, root], timeout: 5000,
    env: { PATH: process.env.PATH, HOME: root, NODE_NO_WARNINGS: '1' } });
  for await (const event of stream) {
    if (['test:stdout', 'test:stderr'].includes(event.type)) { logs.push({ file, ...event }); continue; }
    if (event.type === 'test:summary' && event.data.file === undefined) summary = event.data;
    if (['test:pass','test:fail'].includes(event.type)) events.push({ type: event.type, name: event.data.name,
      file, line: event.data.line ?? null, skip: !!event.data.skip, todo: !!event.data.todo,
      assertion: event.data.details?.error?.cause?.code === 'ERR_ASSERTION',
      failureType: event.data.details?.error?.failureType ?? null });
  }
  results.push({ file, events, summary });
}
const counts = { tests:0, passed:0, failed:0, skipped:0, todo:0, cancelled:0 };
let complete = files.length > 0 && new Set(files).size === files.length;
for (const result of results) {
  complete &&= !!result.summary && result.summary.counts.tests > 0
    && result.events.length === result.summary.counts.tests
    && result.events.every(event => event.name !== worker);
  for (const key of Object.keys(counts)) {
    const value = result.summary?.counts[key];
    if (!Number.isSafeInteger(value) || value < 0) complete = false;
    else counts[key] += value;
  }
}
complete &&= counts.tests === counts.passed + counts.failed + counts.skipped + counts.todo + counts.cancelled;
writeFileSync(output, JSON.stringify({ schema:'fixture-node-lifecycle-v1', complete, counts, files, results, logs }));
process.exitCode = complete && counts.failed === 0 && counts.cancelled === 0 ? 0 : 1;
