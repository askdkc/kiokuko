import { CHATGPT_MEMORY_POLICY } from '../chatgpt/memory-policy.js';
import { resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { getGlobalDatabasePath } from '../config/paths.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { databaseFileIdentity, openConnection, requireDatabaseFileIdentity, type DatabaseFileIdentity } from '../db/connection.js';
import { inspectMigrationSnapshot, loadMigrationSnapshot } from '../db/migrate.js';
import { withDeferredReadTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { captureInteractionMemory } from '../memory/interaction-capture.js';
import { WriteQueue } from '../server/write-queue.js';
import { chatgptCaptureInputSchema } from './chatgpt-contract.js';

export type ChatgptAccess = 'read' | 'read-write';

const UNAVAILABLE = 'ChatGPT memory requires an existing regular database with the supported schema. Initialize or update it locally with a compatible Kiokuko version; preserve unsupported databases. No initialization or migration was performed.';

function validateSchema(database: SqliteDatabase): void {
  const snapshot = loadMigrationSnapshot();
  withDeferredReadTransaction(database, () => {
    if (inspectMigrationSnapshot(database, snapshot).pending.length !== 0) throw new Error('Unsupported schema');
  });
}

/** Fixed local owner binding; no initialization, migration, model or worker. */
export class ChatgptRuntimeOwner {
  readonly access: ChatgptAccess;
  readonly #projectPaths: readonly string[];
  #projects = new Map<string, { workspace: string; displayName: string }>();
  #projectStartup: Promise<void> | undefined;

  async initializeProjects(): Promise<void> {
    if (!this.#projectPaths.length) return;
    return this.#projectStartup ??= (async () => {
      this.start();
      const projects = new Map<string, { workspace: string; displayName: string }>();
      for (const root of this.#projectPaths) {
        const project = await resolveProjectWorkspaceReadOnly(this.#database!, root);
        const stored = project && this.#database!.prepare('SELECT workspace, display_name FROM repositories WHERE repository_id = ?')
          .get<{ workspace: string; display_name: string }>(project.repositoryId);
        if (!project || !stored || stored.workspace !== project.workspace || project.workspace === 'global')
          throw new KiokukoError('VALIDATION_ERROR', 'ChatGPT project requires an existing project binding');
        projects.set(project.repositoryId, { workspace: project.workspace, displayName: stored.display_name });
      }
      this.#projects = projects;
    })();
  }

  policy() {
    if (!this.#projectPaths.length) return { ...CHATGPT_MEMORY_POLICY, access: this.access };
    const projects = [...this.#projects].sort(([a], [b]) => a.localeCompare(b)).map(([repositoryId, value]) => ({ repositoryId, displayName: value.displayName, access: 'read' as const }));
    return { ...CHATGPT_MEMORY_POLICY, access: this.access, projects,
      policyDigest: createHash('sha256').update(JSON.stringify([CHATGPT_MEMORY_POLICY.policyVersion, CHATGPT_MEMORY_POLICY.instructions, projects])).digest('hex') };
  }

  projectWorkspace(repositoryId: string): string {
    const project = this.#projects.get(repositoryId);
    if (!project) throw new KiokukoError('VALIDATION_ERROR', 'Project is not allowed by this connection');
    return project.workspace;
  }
  readonly #databasePath: string;
  #database: SqliteDatabase | undefined;
  #identity: DatabaseFileIdentity | undefined;
  #ownerBinding: string | undefined;
  readonly #queue: WriteQueue<Awaited<ReturnType<typeof captureInteractionMemory>>> | undefined;
  #closing: Promise<void> | undefined;
  #closed = false;

  constructor(databasePath = getGlobalDatabasePath(), access: ChatgptAccess = 'read', projectPaths: readonly string[] = []) {
    if (access !== 'read' && access !== 'read-write') throw new KiokukoError('VALIDATION_ERROR', 'Invalid ChatGPT access');
    if (projectPaths.length > 20) throw new KiokukoError('VALIDATION_ERROR', 'Too many ChatGPT projects');
    this.#projectPaths = [...projectPaths];
    this.access = access;
    this.#queue = access === 'read-write' ? new WriteQueue(64) : undefined;
    this.#databasePath = databasePath;
  }

  start(): void {
    if (this.#closed) throw new KiokukoError('SERVICE_UNAVAILABLE', 'ChatGPT memory runtime is closed');
    if (this.#database !== undefined) return;
    let database: SqliteDatabase | undefined;
    try {
      const identity = databaseFileIdentity(this.#databasePath);
      database = openConnection(this.#databasePath, { readOnly: true, expectedFileIdentity: identity });
      validateSchema(database);
      this.#ownerBinding = realpathSync(this.#databasePath);
      this.#identity = identity;
      this.#database = database;
    } catch (error) {
      try { database?.close(); }
      catch (closeError) { throw new AggregateError([error, closeError], UNAVAILABLE); }
      throw new KiokukoError('SERVICE_UNAVAILABLE', UNAVAILABLE);
    }
  }

  withDatabase<T>(operation: (database: SqliteDatabase) => T): T {
    this.start();
    return operation(this.#database!);
  }

  async capture(raw: unknown): Promise<Awaited<ReturnType<typeof captureInteractionMemory>>> {
    if (this.access !== 'read-write') throw new KiokukoError('SERVICE_UNAVAILABLE', 'Capture is unavailable');
    const parsed = chatgptCaptureInputSchema.safeParse(raw);
    if (!parsed.success) throw new KiokukoError('VALIDATION_ERROR', 'Invalid capture input');
    this.start();
    const input = {
      operationId: 'chatgpt-memory:' + createHash('sha256')
        .update(JSON.stringify([this.#ownerBinding, parsed.data.operationId])).digest('hex'),
      memories: parsed.data.memories.map(memory => ({ ...memory, scope: 'global' as const })),
    };
    const options = { cwd: this.#ownerBinding!, clientKind: 'chatgpt-memory' };
    if (process.env.KIOKUKO_INTERACTION_MEMORY === 'off') return captureInteractionMemory(this.#database!, input, options);
    return this.#queue!.enqueue(async () => {
      requireDatabaseFileIdentity(this.#databasePath, this.#identity!);
      validateSchema(this.#database!);
      const database = openConnection(this.#databasePath, { expectedFileIdentity: this.#identity! });
      try {
        validateSchema(database);
        return await captureInteractionMemory(database, input, options);
      } finally { database.close(); }
    });
  }

  close(): void | Promise<void> {
    if (this.#closed) return this.#closing;
    this.#closed = true;
    const finish = () => {
      this.#database?.close();
      this.#database = undefined;
    };
    if (this.#queue === undefined) return finish();
    this.#closing = this.#queue.close().then(finish);
    return this.#closing;
  }
}
