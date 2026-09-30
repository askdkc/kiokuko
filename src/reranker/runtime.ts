import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { KiokukoError } from '../errors.js';
import { LOCAL_RERANKER_PRESET } from './preset.js';

export interface RerankerPair {
  readonly query: string;
  readonly document: string;
}

export interface RerankerScore {
  readonly score: number | null;
  readonly reason?: 'token_limit' | 'input_limit';
}

export interface RerankerWorkerClient {
  score(pairs: readonly RerankerPair[], options?: { readonly signal?: AbortSignal }): Promise<readonly RerankerScore[]>;
  close(): Promise<void>;
}

interface PendingJob {
  readonly id: number;
  readonly pairs: readonly RerankerPair[];
  readonly signal?: AbortSignal;
  readonly resolve: (value: readonly RerankerScore[]) => void;
  readonly reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
  abortListener?: () => void;
  settled: boolean;
}

interface WorkerMessage {
  readonly id?: number;
  readonly type?: 'ready' | 'scores' | 'error' | 'shutdown';
  readonly scores?: unknown;
  readonly message?: string;
}

const MAX_PAIRS = 32;
const MAX_QUEUE = 2;
const MAX_INPUT_BYTES = 262_144;
export const MAX_RERANKER_BATCH_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_LINE_BYTES = 9_000_000;
const MAX_OUTPUT_LINE_CHARS = 8_192;

function interrupted(): KiokukoError {
  return new KiokukoError('SERVICE_UNAVAILABLE', 'Local reranker inference was interrupted');
}

function validatePairs(pairs: readonly RerankerPair[], maxInputBytes: number): void {
  if (!Array.isArray(pairs) || pairs.length < 1 || pairs.length > MAX_PAIRS) {
    throw new KiokukoError('VALIDATION_ERROR', 'Reranker candidate batch is invalid');
  }
  let totalBytes = 0;
  for (const pair of pairs) {
    if (typeof pair !== 'object' || pair === null
      || typeof pair.query !== 'string' || pair.query.length === 0
      || typeof pair.document !== 'string' || pair.document.length === 0
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(pair.query + pair.document)) {
      throw new KiokukoError('VALIDATION_ERROR', 'Reranker input is invalid or exceeds its byte limit');
    }
    const pairBytes = Buffer.byteLength(pair.query, 'utf8') + Buffer.byteLength(pair.document, 'utf8');
    if (pairBytes > maxInputBytes) {
      throw new KiokukoError('VALIDATION_ERROR', 'Reranker input is invalid or exceeds its byte limit');
    }
    totalBytes += pairBytes;
    if (totalBytes > MAX_RERANKER_BATCH_BYTES) {
      throw new KiokukoError('VALIDATION_ERROR', 'Reranker input batch exceeds its byte limit');
    }
  }
}

function parseScores(value: unknown, expectedCount: number): readonly RerankerScore[] {
  if (!Array.isArray(value) || value.length !== expectedCount) throw new KiokukoError('INTEGRITY_ERROR', 'Local reranker returned an invalid score batch');
  return value.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new KiokukoError('INTEGRITY_ERROR', 'Local reranker returned an invalid score');
    const score = (item as { score?: unknown }).score;
    const reason = (item as { reason?: unknown }).reason;
    if (score === null) {
      if (reason !== 'token_limit' && reason !== 'input_limit') throw new KiokukoError('INTEGRITY_ERROR', 'Local reranker returned an invalid abstention reason');
      return { score: null, reason };
    }
    if (typeof score !== 'number' || !Number.isFinite(score) || Math.abs(score) > 1_000_000 || reason !== undefined) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Local reranker returned an anomalous score');
    }
    return { score };
  });
}

export interface LocalRerankerRuntimeOptions {
  readonly modelDirectory: string;
  readonly timeoutMs?: number;
  readonly maxInputBytes?: number;
  readonly executable?: string;
  readonly workerPath?: string;
  readonly spawn?: typeof spawnProcess;
}

/** One persistent, serialized child process. It is created only on first active/observe use. */
export class LocalRerankerRuntime implements RerankerWorkerClient {
  readonly #options: LocalRerankerRuntimeOptions;
  readonly #queue: PendingJob[] = [];
  #child: ChildProcessWithoutNullStreams | undefined;
  #reader: ReadlineInterface | undefined;
  #ready: Promise<void> | undefined;
  #running: PendingJob | undefined;
  #stderr = '';
  #closed = false;
  #sequence = 0;

  constructor(options: LocalRerankerRuntimeOptions) {
    this.#options = options;
  }

  score(pairs: readonly RerankerPair[], options: { readonly signal?: AbortSignal } = {}): Promise<readonly RerankerScore[]> {
    validatePairs(pairs, this.#options.maxInputBytes ?? MAX_INPUT_BYTES);
    if (this.#closed) return Promise.reject(new KiokukoError('SERVICE_UNAVAILABLE', 'Local reranker runtime is closed'));
    if (options.signal?.aborted) return Promise.reject(interrupted());
    if (this.#running !== undefined && this.#queue.length >= MAX_QUEUE) {
      return Promise.reject(new KiokukoError('BACKPRESSURE', 'Local reranker wait queue is full'));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.#sequence;
      const job: PendingJob = {
        id, pairs, resolve, reject, settled: false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeout: setTimeout(() => this.#expire(job), this.#options.timeoutMs ?? 60_000),
      };
      if (options.signal !== undefined) {
        job.abortListener = () => this.#abort(job);
        options.signal.addEventListener('abort', job.abortListener, { once: true });
      }
      this.#queue.push(job);
      this.#pump();
    });
  }

  async #ensureWorker(): Promise<void> {
    if (this.#child !== undefined && this.#ready !== undefined) return this.#ready;
    if (this.#ready !== undefined) return this.#ready;
    const spawn = this.#options.spawn ?? spawnProcess;
    const workerPath = this.#options.workerPath ?? fileURLToPath(new URL('./worker.js', import.meta.url));
    const child = spawn(this.#options.executable ?? process.execPath, [workerPath, this.#options.modelDirectory,
      String(this.#options.maxInputBytes ?? MAX_INPUT_BYTES), String(MAX_RERANKER_BATCH_BYTES)],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.#child = child;
    this.#stderr = '';
    this.#reader = createInterface({ input: child.stdout });
    this.#reader.on('line', (line) => this.#receive(line));
    child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString('utf8')).slice(-8_192);
    });
    child.on('error', (error) => {
      if (this.#child !== child) return;
      this.#failRunning(new KiokukoError('SERVICE_UNAVAILABLE', 'Local reranker worker failed', { cause: error.message }));
      this.#forgetWorker();
      this.#pump();
    });
    child.on('exit', (code, signal) => {
      if (this.#child !== child) return;
      this.#failRunning(new KiokukoError('SERVICE_UNAVAILABLE', `Local reranker worker exited (${signal ?? code ?? 'unknown'})`));
      this.#forgetWorker();
      this.#pump();
    });
    this.#ready = new Promise<void>((resolve, reject) => {
      const childError = (error: Error) => reject(new KiokukoError('SERVICE_UNAVAILABLE', 'Could not start local reranker worker', { cause: error.message }));
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => reject(new KiokukoError('SERVICE_UNAVAILABLE', `Local reranker worker exited before initialization (${signal ?? code ?? 'unknown'})`));
      const onReady = () => {
        child.off('error', childError);
        child.off('exit', onExit);
        resolve();
      };
      const onMessage = (line: string) => {
        let message: WorkerMessage;
        try { message = JSON.parse(line) as WorkerMessage; } catch { return; }
        if (message.type !== 'ready') return;
        this.#reader?.off('line', onMessage);
        onReady();
      };
      this.#reader?.on('line', onMessage);
      child.once('error', childError);
      child.once('exit', onExit);
    }).catch((error: unknown) => {
      if (this.#child === child) this.#forgetWorker();
      throw error;
    });
    return this.#ready;
  }

  #receive(line: string): void {
    if (line.length > MAX_OUTPUT_LINE_CHARS) {
      this.#failRunning(new KiokukoError('INTEGRITY_ERROR', 'Local reranker worker response exceeded its protocol limit'));
      this.#terminateWorker();
      return;
    }
    let message: WorkerMessage;
    try { message = JSON.parse(line) as WorkerMessage; } catch {
      this.#failRunning(new KiokukoError('INTEGRITY_ERROR', 'Local reranker worker returned invalid JSON'));
      this.#terminateWorker();
      return;
    }
    if (message.type === 'ready' || message.type === 'shutdown') return;
    const job = this.#running;
    if (job === undefined || message.id !== job.id) {
      this.#failRunning(new KiokukoError('INTEGRITY_ERROR', 'Local reranker worker response does not match the active request'));
      this.#terminateWorker();
      this.#pump();
      return;
    }
    if (message.type === 'error') {
      this.#settle(job, new KiokukoError('SERVICE_UNAVAILABLE', 'Local reranker inference failed'));
      this.#terminateWorker();
    } else if (message.type === 'scores') {
      try { this.#settle(job, undefined, parseScores(message.scores, job.pairs.length)); }
      catch (error) { this.#settle(job, error); this.#terminateWorker(); }
    } else {
      this.#settle(job, new KiokukoError('INTEGRITY_ERROR', 'Local reranker worker returned an unknown response'));
      this.#terminateWorker();
    }
    this.#running = undefined;
    this.#pump();
  }

  #pump(): void {
    if (this.#closed || this.#running !== undefined) return;
    const job = this.#queue.shift();
    if (job === undefined) return;
    if (job.signal?.aborted) {
      this.#settle(job, interrupted());
      this.#pump();
      return;
    }
    this.#running = job;
    const request = JSON.stringify({ id: job.id, pairs: job.pairs });
    if (Buffer.byteLength(request, 'utf8') > MAX_REQUEST_LINE_BYTES) {
      this.#settle(job, new KiokukoError('VALIDATION_ERROR', 'Reranker request exceeded its protocol limit'));
      this.#running = undefined;
      this.#pump();
      return;
    }
    void this.#ensureWorker().then(() => {
      if (job.settled || this.#running !== job || job.signal?.aborted) return;
      this.#child?.stdin.write(`${request}\n`, (error) => {
        if (error !== null && error !== undefined) {
          this.#settle(job, new KiokukoError('SERVICE_UNAVAILABLE', 'Could not write to local reranker worker'));
          this.#running = undefined;
          this.#terminateWorker();
          this.#pump();
        }
      });
    }).catch((error: unknown) => {
      if (job.settled) return;
      this.#settle(job, error);
      this.#running = undefined;
      this.#pump();
    });
  }

  #settle(job: PendingJob, error?: unknown, scores?: readonly RerankerScore[]): void {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timeout);
    if (job.signal !== undefined && job.abortListener !== undefined) job.signal.removeEventListener('abort', job.abortListener);
    if (error !== undefined) job.reject(error);
    else job.resolve(scores ?? []);
  }

  #expire(job: PendingJob): void {
    if (job.settled) return;
    const queuedIndex = this.#queue.indexOf(job);
    if (queuedIndex >= 0) this.#queue.splice(queuedIndex, 1);
    const active = this.#running === job;
    this.#settle(job, new KiokukoError('SERVICE_UNAVAILABLE', 'Local reranker inference timed out'));
    if (active) {
      this.#running = undefined;
      this.#terminateWorker();
      this.#pump();
    }
  }

  #abort(job: PendingJob): void {
    if (job.settled) return;
    const queuedIndex = this.#queue.indexOf(job);
    if (queuedIndex >= 0) this.#queue.splice(queuedIndex, 1);
    const active = this.#running === job;
    this.#settle(job, interrupted());
    if (active) {
      this.#running = undefined;
      this.#terminateWorker();
      this.#pump();
    }
  }

  #failRunning(error: unknown): void {
    if (this.#running !== undefined) this.#settle(this.#running, error);
    this.#running = undefined;
  }

  #forgetWorker(): void {
    this.#reader?.close();
    this.#reader = undefined;
    this.#child = undefined;
    this.#ready = undefined;
    this.#stderr = '';
  }

  #terminateWorker(): void {
    const child = this.#child;
    if (child === undefined) return;
    this.#forgetWorker();
    child.kill('SIGTERM');
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const job of this.#queue.splice(0)) this.#settle(job, new KiokukoError('SERVICE_UNAVAILABLE', 'Local reranker runtime is shutting down'));
    if (this.#running !== undefined) this.#settle(this.#running, new KiokukoError('SERVICE_UNAVAILABLE', 'Local reranker runtime is shutting down'));
    this.#running = undefined;
    const child = this.#child;
    this.#forgetWorker();
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const stopped = await Promise.race([exited.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000))]);
      if (!stopped) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  }
}

export function createLocalRerankerRuntime(modelDirectory: string, options: Omit<LocalRerankerRuntimeOptions, 'modelDirectory'> = {}): LocalRerankerRuntime {
  return new LocalRerankerRuntime({ modelDirectory, ...options });
}

export function rerankerRuntimeIdentity(): { presetId: string; revision: string; dtype: 'q8' } {
  return { presetId: LOCAL_RERANKER_PRESET.id, revision: LOCAL_RERANKER_PRESET.revision, dtype: LOCAL_RERANKER_PRESET.dtype };
}
