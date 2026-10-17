import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseProjectConfig, parseProjectConfigText, type ProjectConfig } from '../config/project-config.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { AGENT_TEMPLATE_VERSION } from '../agent-file/render.js';
import { assertAtomicCleanupComplete, assertFileExpectation, atomicWriteTextIfUnchanged, readDirectoryIdentity, readRegularFile } from '../agent-file/atomic-write.js';
import { diagnosticError } from '../diagnostics/error.js';

export interface BindingRegistration extends Record<string, unknown> {
  canonicalRoot: string;
  repositoryId: string;
  workspace: string;
  bindingSchemaVersion: number;
  agentTemplateVersion: number;
}

export function bindingRegistrations(database: SqliteDatabase): BindingRegistration[] {
  return database.prepare(`SELECT l.canonical_root AS canonicalRoot, r.repository_id AS repositoryId,
    r.workspace, r.binding_schema_version AS bindingSchemaVersion, r.agent_template_version AS agentTemplateVersion
    FROM repository_locations l JOIN repositories r USING(repository_id) ORDER BY l.canonical_root`).all<BindingRegistration>();
}

type RepairPlan = { kind: 'create' | 'recreate' | 'unchanged'; config: ProjectConfig; detail: string }
  | { kind: 'refuse'; detail: string };

/** Decide from supplied evidence only; never mint identity or infer it from a directory name. */
export function planBindingRepair(root: string, registrations: readonly BindingRegistration[], original: string | undefined): RepairPlan {
  if (!path.isAbsolute(root) || path.normalize(root) !== root) return { kind: 'refuse', detail: 'Repository root must be an absolute canonical registered path' };
  const rows = registrations.filter(r => r.canonicalRoot === root);
  if (rows.length !== 1) return { kind: 'refuse', detail: 'Location registration is missing or ambiguous' };
  const row = rows[0]!;
  if (registrations.some(r => (r.repositoryId === row.repositoryId && r.workspace !== row.workspace)
    || (r.workspace === row.workspace && r.repositoryId !== row.repositoryId))) return { kind: 'refuse', detail: 'Registered identity and workspace conflict' };
  if (!Number.isSafeInteger(row.agentTemplateVersion) || row.agentTemplateVersion < 0) return { kind: 'refuse', detail: 'Registered template metadata is invalid' };
  let fields: Record<string, unknown> = {};
  if (original !== undefined) {
    try {
      const config = parseProjectConfigText(original);
      if (config.repositoryId !== row.repositoryId || config.workspace !== row.workspace) return { kind: 'refuse', detail: 'Existing valid binding conflicts with registered identity' };
      return { kind: 'unchanged', config, detail: 'Existing binding identity matches registration' };
    } catch (error) {
      if (!(error instanceof KiokukoError) || error.code !== 'VALIDATION_ERROR') throw error;
    }
    try {
      const value: unknown = JSON.parse(original);
      if (value && typeof value === 'object' && !Array.isArray(value)) fields = value as Record<string, unknown>;
    } catch { /* Broken JSON has no usable settings; its exact text will be backed up. */ }
    if ((typeof fields.repositoryId === 'string' && fields.repositoryId !== row.repositoryId)
      || (typeof fields.workspace === 'string' && fields.workspace !== row.workspace)) return { kind: 'refuse', detail: 'Broken binding also declares a conflicting identity' };
    if (typeof fields.schemaVersion === 'number' && Number.isSafeInteger(fields.schemaVersion) && fields.schemaVersion > 1) return { kind: 'refuse', detail: 'A newer binding schema is unsupported, not proven broken' };
  }
  const config = { schemaVersion: row.bindingSchemaVersion, repositoryId: row.repositoryId, workspace: row.workspace,
    agentFile: 'AGENTS.md', templateVersion: row.agentTemplateVersion || AGENT_TEMPLATE_VERSION };
  try {
    // Preserve a valid custom agent path when the rest of the old config is broken.
    if (typeof fields.agentFile === 'string') {
      try { parseProjectConfig({ ...config, agentFile: fields.agentFile }); config.agentFile = fields.agentFile; } catch { /* Use the same default as kiokuko use. */ }
    }
    const validated = parseProjectConfig(config);
    return { kind: original === undefined ? 'create' : 'recreate', config: validated,
      detail: 'Identity and workspace come from registration. Unrecorded settings use kiokuko use defaults; instruction files and their applicability remain unverified.' };
  } catch { return { kind: 'refuse', detail: 'Registered metadata cannot produce a supported project binding' }; }
}

export interface BindingRepairResult {
  repositoryRoot: string;
  repositoryId?: string;
  status: 'created' | 'recreated' | 'unchanged' | 'refused' | 'failed';
  detail: string;
  backupPath?: string;
}

export interface BindingRepairOptions {
  roots?: readonly string[];
  /** I/O seam for testing races/failures immediately before the conditional write. */
  beforeWrite?: (filePath: string) => void | Promise<void>;
  readBinding?: typeof readRegularFile;
}

/** The database is an authority to read, never an object repaired by this operation. */
export async function repairRegisteredBindings(database: SqliteDatabase, options: BindingRepairOptions = {}): Promise<BindingRepairResult[]> {
  const registrations = bindingRegistrations(database);
  const roots = [...new Set(options.roots ?? registrations.map(r => r.canonicalRoot))];
  const results: BindingRepairResult[] = [];
  for (const root of roots) {
    const result: BindingRepairResult = { repositoryRoot: root, status: 'refused', detail: '' };
    const registration = registrations.find(r => r.canonicalRoot === root);
    if (registration) result.repositoryId = registration.repositoryId;
    try {
      const initial = planBindingRepair(root, registrations, undefined);
      if (initial.kind === 'refuse') { result.detail = initial.detail; results.push(result); continue; }
      if (await realpath(root) !== root) throw new KiokukoError('CONFLICT', 'Registered directory no longer resolves to its canonical path');
      const identity = await readDirectoryIdentity(root), filePath = path.join(root, '.kiokuko.json');
      if (identity === undefined) throw new KiokukoError('CONFLICT', 'Registered directory disappeared');
      const original = await (options.readBinding ?? readRegularFile)(filePath, { containmentRoot: root });
      const plan = planBindingRepair(root, registrations, original?.content);
      result.detail = plan.detail;
      if (plan.kind === 'refuse' || plan.kind === 'unchanged') { result.status = plan.kind === 'refuse' ? 'refused' : 'unchanged'; results.push(result); continue; }
      let backup: Awaited<ReturnType<typeof readRegularFile>>;
      if (original !== undefined) {
        result.backupPath = path.join(root, `.kiokuko.json.recovery-${randomUUID()}.bak`);
        const saved = await atomicWriteTextIfUnchanged(result.backupPath, original.content,
          { expected: undefined, containmentRoot: root, expectedParentDirectory: identity }, original.mode);
        assertAtomicCleanupComplete(saved); backup = saved.installed;
        // Never replace the original unless its recoverable copy is still exact.
        await assertFileExpectation(result.backupPath, { expected: backup, containmentRoot: root });
      }
      const installed = await atomicWriteTextIfUnchanged(filePath, JSON.stringify(plan.config, null, 2) + '\n',
        { expected: original, containmentRoot: root, expectedParentDirectory: identity }, original?.mode ?? 0o600,
        { beforeCommit: async () => {
          await options.beforeWrite?.(filePath);
          if (JSON.stringify(bindingRegistrations(database)) !== JSON.stringify(registrations)) throw new KiokukoError('CONFLICT', 'Repository registration changed during repair');
          if (result.backupPath) await assertFileExpectation(result.backupPath, { expected: backup, containmentRoot: root });
        } });
      assertAtomicCleanupComplete(installed);
      await assertFileExpectation(filePath, { expected: installed.installed, containmentRoot: root });
      result.status = plan.kind === 'create' ? 'created' : 'recreated';
    } catch (error) {
      const diagnostic = diagnosticError(error);
      result.status = diagnostic.code === 'CONFLICT' || diagnostic.code === 'SECURITY_REJECTION' ? 'refused' : 'failed';
      result.detail = `${diagnostic.code}: ${diagnostic.message}`;
    }
    results.push(result);
  }
  return results;
}
