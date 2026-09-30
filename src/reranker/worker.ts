import { createInterface } from 'node:readline';
import { KiokukoError } from '../errors.js';
import { LOCAL_RERANKER_PRESET } from './preset.js';

interface Pair {
  query: string;
  document: string;
}

interface ScoreRequest {
  id: number;
  pairs: Pair[];
}

interface TokenTensor {
  readonly dims: readonly number[];
  readonly data: ArrayLike<unknown>;
}

interface ModelOutput {
  readonly logits?: TokenTensor;
}

const MAX_CANDIDATES = 32;
const MAX_TOKENS = LOCAL_RERANKER_PRESET.maximumTokens;
const modelDirectory = process.argv[2];
const configuredMaxInputBytes = Number(process.argv[3] ?? 262_144);
const MAX_INPUT_BYTES = Number.isSafeInteger(configuredMaxInputBytes) && configuredMaxInputBytes >= 1_024
  ? Math.min(configuredMaxInputBytes, 1_048_576)
  : 262_144;
const configuredMaxBatchBytes = Number(process.argv[4] ?? 4 * 1024 * 1024);
const MAX_BATCH_BYTES = Number.isSafeInteger(configuredMaxBatchBytes) && configuredMaxBatchBytes >= 1_024
  ? Math.min(configuredMaxBatchBytes, 4 * 1024 * 1024)
  : 4 * 1024 * 1024;

console.log = (...args: unknown[]) => { process.stderr.write(`${args.map(String).join(' ')}\n`); };
console.info = console.log;
console.warn = console.log;

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function validateRequest(value: unknown): ScoreRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KiokukoError('VALIDATION_ERROR', 'Invalid reranker request');
  const request = value as Partial<ScoreRequest>;
  if (!Number.isSafeInteger(request.id) || (request.id ?? 0) < 1 || !Array.isArray(request.pairs)
    || request.pairs.length < 1 || request.pairs.length > MAX_CANDIDATES) throw new KiokukoError('VALIDATION_ERROR', 'Invalid reranker request');
  let totalBytes = 0;
  for (const pair of request.pairs) {
    if (typeof pair !== 'object' || pair === null
      || typeof pair.query !== 'string' || pair.query.length === 0
      || typeof pair.document !== 'string' || pair.document.length === 0
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(pair.query + pair.document)) {
      throw new KiokukoError('VALIDATION_ERROR', 'Invalid reranker request');
    }
    const pairBytes = Buffer.byteLength(pair.query, 'utf8') + Buffer.byteLength(pair.document, 'utf8');
    if (pairBytes > MAX_INPUT_BYTES) throw new KiokukoError('VALIDATION_ERROR', 'Invalid reranker request');
    totalBytes += pairBytes;
    if (totalBytes > MAX_BATCH_BYTES) throw new KiokukoError('VALIDATION_ERROR', 'Reranker input batch exceeds its limit');
  }
  return request as ScoreRequest;
}

async function main(): Promise<void> {
  if (modelDirectory === undefined || modelDirectory.length === 0) throw new KiokukoError('VALIDATION_ERROR', 'Reranker model path is missing');
  const transformers = await import('@huggingface/transformers');
  transformers.env.allowLocalModels = true;
  transformers.env.allowRemoteModels = false;
  transformers.env.localModelPath = modelDirectory.endsWith('/') ? modelDirectory : `${modelDirectory}/`;
  const tokenizer = await transformers.AutoTokenizer.from_pretrained(modelDirectory, { local_files_only: true });
  const model = await transformers.AutoModelForSequenceClassification.from_pretrained(modelDirectory, {
    local_files_only: true,
    dtype: LOCAL_RERANKER_PRESET.dtype,
  });
  emit({ type: 'ready' });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let sequence = Promise.resolve();
  input.on('line', (line) => {
      sequence = sequence.then(async () => {
      if (Buffer.byteLength(line, 'utf8') > 9_000_000) throw new KiokukoError('VALIDATION_ERROR', 'Reranker request exceeded its protocol limit');
      const message = JSON.parse(line) as { action?: unknown };
      if (message.action === 'shutdown') {
        await model.dispose();
        emit({ type: 'shutdown' });
        input.close();
        return;
      }
      const request = validateRequest(message);
      const scores = [] as Array<{ score: number | null; reason?: 'token_limit' | 'input_limit' }>;
      for (const pair of request.pairs) {
        if (Buffer.byteLength(pair.query, 'utf8') + Buffer.byteLength(pair.document, 'utf8') > MAX_INPUT_BYTES) {
          scores.push({ score: null, reason: 'input_limit' });
          continue;
        }
        const tokenCount = tokenizer.encode(pair.query, { text_pair: pair.document, add_special_tokens: true }).length;
        if (tokenCount > MAX_TOKENS) {
          scores.push({ score: null, reason: 'token_limit' });
          continue;
        }
        const inputs = await tokenizer(pair.query, {
          text_pair: pair.document,
          truncation: false,
          max_length: MAX_TOKENS,
        });
        const output = await model(inputs) as ModelOutput;
        const logits = output.logits;
        if (logits === undefined || logits.dims.length !== 2 || logits.dims[0] !== 1 || logits.dims[1] !== 1
          || logits.data.length !== 1 || typeof logits.data[0] !== 'number'
          || !Number.isFinite(logits.data[0]) || Math.abs(logits.data[0]) > 1_000_000) {
          throw new KiokukoError('INTEGRITY_ERROR', 'Reranker score tensor has an invalid shape or value');
        }
        scores.push({ score: logits.data[0] as number });
      }
      emit({ type: 'scores', id: request.id, scores });
    }).catch((error: unknown) => {
      const id = (() => { try { return (JSON.parse(line) as { id?: unknown }).id; } catch { return undefined; } })();
      emit({ type: 'error', ...(Number.isSafeInteger(id) ? { id } : {}), message: error instanceof Error ? error.name : 'Error' });
      input.close();
      process.exitCode = 6;
    });
  });
}

void main().catch(() => {
  emit({ type: 'error', message: 'initialization_failed' });
  process.exitCode = 6;
});
