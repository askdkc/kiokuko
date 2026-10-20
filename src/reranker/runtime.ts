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

interface WorkerSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly reader: ReadlineInterface;
  readonly ready: Promise<void>;
  readonly resolveReady: () => void;
  readonly rejectReady: (error: unknown) => void;
  readonly exited: Promise<void>;
  initialized: boolean;
  retiring: boolean;
  stopped: boolean;
  killTimer?: NodeJS.Timeout;
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
  #worker: WorkerSession | undefined;
  readonly #children = new Set<WorkerSession>();
  #closing: Promise<void> | undefined;
  #running: PendingJob | undefined;
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

  #ensureWorker(): WorkerSession {
    if (this.#worker !== undefined) return this.#worker;
    const spawn = this.#options.spawn ?? spawnProcess;
    const workerPath = this.#options.workerPath ?? fileURLToPath(new URL('./worker.js', import.meta.url));
    const child = spawn(this.#options.executable ?? process.execPath, [workerPath, this.#options.modelDirectory,
      String(this.#options.maxInputBytes ?? MAX_INPUT_BYTES), String(MAX_RERANKER_BATCH_BYTES)],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    let resolveExited!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
    const worker: WorkerSession = {
      child, reader: createInterface({ input: child.stdout }), ready,
      resolveReady, rejectReady, exited,
      initialized: false, retiring: false, stopped: false,
    };
    this.#worker = worker;
    this.#children.add(worker);
    // Drain stderr without retaining model or input data.
    child.stderr.resume();
    worker.reader.on('line', (line) => this.#receive(worker, line));
    child.stdin.on('error', () => {
      this.#failWorker(worker, new KiokukoError('SERVICE_UNAVAILABLE', 'Could not write to local reranker worker'));
    });
    const stopped = () => {
      if (worker.stopped) return;
      worker.stopped = true;
      clearTimeout(worker.killTimer);
      worker.reader.close();
      this.#children.delete(worker);
      resolveExited();
    };
    child.on('error', (error) => {
      this.#failWorker(worker, new KiokukoError('SERVICE_UNAVAILABLE', 'Local reranker worker failed', { cause: error.message }));
      // A failed spawn has no process and will not emit exit.
      if (child.pid === undefined) stopped();
    });
    child.once('exit', (code, signal) => {
      stopped();
      this.#failWorker(worker, new KiokukoError('SERVICE_UNAVAILABLE', `Local reranker worker exited (${signal ?? code ?? 'unknown'})`));
    });
    return worker;
  }

  #failWorker(worker: WorkerSession, error: unknown): void {
    worker.rejectReady(error);
    if (this.#worker !== worker) return;
    this.#failRunning(error);
    this.#terminateWorker();
    this.#pump();
  }

  #receive(worker: WorkerSession, line: string): void {
    if (this.#worker !== worker || worker.retiring) return;
    try {
      if (line.length > MAX_OUTPUT_LINE_CHARS) throw new Error('response exceeded its protocol limit');
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid envelope');
      const message = value as Record<string, unknown>;
      if (!worker.initialized) {
        if (message.type === 'error' && message.id === undefined && typeof message.message === 'string') {
          this.#failWorker(worker, new KiokukoError('SERVICE_UNAVAILABLE', 'Local reranker initialization failed'));
          return;
        }
        if (message.type !== 'ready' || message.id !== undefined || message.scores !== undefined) throw new Error('invalid initialization response');
        worker.initialized = true;
        worker.resolveReady();
        return;
      }
      const job = this.#running;
      if ((message.type !== 'scores' && message.type !== 'error')
        || !Number.isSafeInteger(message.id) || (message.id as number) < 1
        || job === undefined || message.id !== job.id) throw new Error('response does not match the active request');
      if (message.type === 'error') {
        if (typeof message.message !== 'string') throw new Error('invalid error response');
        this.#failWorker(worker, new KiokukoError('SERVICE_UNAVAILABLE', 'Local reranker inference failed'));
        return;
      }
      const scores = parseScores(message.scores, job.pairs.length);
      this.#settle(job, undefined, scores);
      this.#running = undefined;
      this.#pump();
    } catch (error) {
      this.#failWorker(worker, new KiokukoError('INTEGRITY_ERROR', 'Local reranker returned an invalid protocol response'));
    }
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
    let worker: WorkerSession;
    try { worker = this.#ensureWorker(); } catch (error) {
      this.#settle(job, error);
      this.#running = undefined;
      this.#pump();
      return;
    }
    void worker.ready.then(() => {
      if (job.settled || this.#running !== job || job.signal?.aborted) return;
      if (this.#worker !== worker || worker.retiring) return;
      worker.child.stdin.write(`${request}\n`, (error) => {
        if (this.#worker !== worker || this.#running !== job || job.settled) return;
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

  #terminateWorker(): void {
    const worker = this.#worker;
    if (worker === undefined) return;
    this.#worker = undefined;
    worker.retiring = true;
    worker.reader.close();
    worker.rejectReady(new KiokukoError('SERVICE_UNAVAILABLE', 'Local reranker worker stopped'));
    if (worker.stopped) return;
    // Keep ownership until exit, including after timeout/abort and replacement.
    worker.killTimer = setTimeout(() => {
      if (!worker.stopped) worker.child.kill('SIGKILL');
    }, 2_000);
    worker.child.kill('SIGTERM');
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#closed = true;
    const error = new KiokukoError('SERVICE_UNAVAILABLE', 'Local reranker runtime is shutting down');
    for (const job of this.#queue.splice(0)) this.#settle(job, error);
    this.#failRunning(error);
    this.#terminateWorker();
    this.#closing = Promise.all([...this.#children].map((worker) => worker.exited)).then(() => undefined);
    return this.#closing;
  }

}

export function createLocalRerankerRuntime(modelDirectory: string, options: Omit<LocalRerankerRuntimeOptions, 'modelDirectory'> = {}): LocalRerankerRuntime {
  return new LocalRerankerRuntime({ modelDirectory, ...options });
}

export function rerankerRuntimeIdentity(): { presetId: string; revision: string; dtype: 'q8' } {
  return { presetId: LOCAL_RERANKER_PRESET.id, revision: LOCAL_RERANKER_PRESET.revision, dtype: LOCAL_RERANKER_PRESET.dtype };
}
