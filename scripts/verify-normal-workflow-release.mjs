import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { releaseCandidateGate } from './lib/normal-workflow/contracts.mjs';

const { values } = parseArgs({ options: { candidate: { type: 'string' }, deterministic: { type: 'string', multiple: true }, live: { type: 'string', multiple: true } } });
try {
  const candidate = JSON.parse(readFileSync(values.candidate, 'utf8'));
  const deterministic = (values.deterministic ?? []).flatMap(file => JSON.parse(readFileSync(file, 'utf8')));
  const summaries = (values.live ?? []).map(file => JSON.parse(readFileSync(file, 'utf8')));
  const result = releaseCandidateGate(candidate, deterministic, summaries);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.releaseReady ? 0 : 1;
} catch {
  console.log(JSON.stringify({ releaseReady: false, reasons: ['Release evidence is missing or malformed'] }));
  process.exitCode = 1;
}
