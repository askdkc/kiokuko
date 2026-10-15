import { assuranceDoctor } from '../assurance/doctor.js';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { AtomicCommittedMutationError, assertAtomicCleanupComplete, assertFileExpectation, atomicWriteTextIfUnchanged, unlinkRegularFileIfUnchanged, readDirectoryIdentity, readRegularFile } from '../agent-file/atomic-write.js';
import { isDshOnlyAgentFile, readManagedBlockTemplateVersion } from '../agent-file/managed-block.js';
import { AGENT_TEMPLATE_VERSION, GENERATED_AGENT_FILE, renderGeneratedAgentFile, renderAgentFile } from '../agent-file/render.js';
import { getCodexConfigPath, getDatabaseLockPath, getRuntimeDescriptorPath } from '../config/paths.js';
import { parseProjectConfigText } from '../config/project-config.js';
import type { SqliteDatabase } from '../db/adapter.js';
import { openConnection } from '../db/connection.js';
import { EmbeddingBackendUnavailableError, openEmbeddingDatabase } from '../embedding/backend.js';
import { parseEmbeddingConfig } from '../embedding/config.js';
import { inspectEmbeddingHealth } from '../embedding/diagnostics.js';
import { readPersistedEmbeddingSettings } from '../embedding/settings.js';
import type { VectorSearchBackend } from '../embedding/types.js';
import { KiokukoError } from '../errors.js';
import { diagnosticError } from '../diagnostics/error.js';
import { inspectLedger } from '../ledger/maintenance.js';
import { hybridSearchProjectionStatus } from '../memory/rebuild-search.js';
import { readEntryRevision } from '../memory/revisions.js';
import { findSecret } from '../memory/secrets.js';
import { listRepositoryLocations, type RepositoryLocation } from '../repository/binding.js';
import { isPidAlive } from '../server/instance-lock.js';
import { readRuntimeDescriptor } from '../server/runtime-descriptor.js';
import { setupMcpIdentityConflictClient } from '../setup/mcp-conflict.js';
import { renderCodexMcpConfig } from '../setup/render.js';
import { initializeDatabase } from './init.js';

export interface DoctorCheck {
  ok: boolean;
  status?: 'ok' | 'attention' | 'failed';
  count?: number;
  detail?: string;
}

export interface DoctorAgentFileFinding {
  repositoryRoot: string;
  repositoryId: string;
  agentFile: string | null;
  reason: 'missing_binding_file' | 'missing_generated_file' | 'outdated_generated_file' | 'missing_agent_file' | 'missing_managed_block' | 'outdated_managed_block' | 'invalid_binding' | 'unreadable_agent_file' | 'invalid_managed_block';
  bindingFile?: string;
  detail?: string;
  action?: string;
}

export interface DoctorResult {
  ok: boolean;
  status?: 'ok' | 'attention' | 'failed';
  databasePath: string;
  currentVersion: number;
  capabilities: Awaited<ReturnType<typeof initializeDatabase>>['capabilities'] | null;
  integrity: string;
  fts5: boolean;
  checks: {
    integrity: DoctorCheck;
    foreignKeys: DoctorCheck;
    entryRevisions: DoctorCheck;
    revisionTags: DoctorCheck;
    deliveryRevisions: DoctorCheck;
    revisionHashes: DoctorCheck;
    migrations: DoctorCheck;
    fts: DoctorCheck;
    danglingLinks: DoctorCheck;
    contradictions: DoctorCheck;
    bindings: DoctorCheck;
    agentFiles: DoctorCheck & { findings: DoctorAgentFileFinding[] };
    permissions: DoctorCheck;
    secrets: DoctorCheck;
    ledger: DoctorCheck;
    nudgeDeliveries: DoctorCheck;
    runtime: DoctorCheck;
    hybridSearch: DoctorCheck;
    embeddings: DoctorCheck;
    codexMcp: DoctorCheck;
    memoryAssurance: ReturnType<typeof assuranceDoctor>;
  };
}

export interface DoctorOptions {
  verifyRepositories?: boolean;
  databasePath?: string;
  migrationsDirectory?: string;
  runtimeDescriptorPath?: string;
  embeddingEnvironment?: NodeJS.ProcessEnv;
  embeddingBackend?: VectorSearchBackend;
}

export interface DoctorDependencies {
  openConnection?: typeof openConnection;
}

export interface DoctorPromptOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

const MAX_DOCTOR_PROMPT_LOCATIONS = 20;

/** Offer only bounded, renderable repairs; require consent and unchanged file identities. */
export async function promptRepairAgentFiles(
  findings: readonly DoctorAgentFileFinding[],
  options: DoctorPromptOptions = {},
): Promise<number> {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  let created = 0;
  if ((input as { isTTY?: boolean }).isTTY !== true || (output as { isTTY?: boolean }).isTTY !== true) return created;
  for (const finding of findings) {
    if (!['missing_agent_file', 'missing_managed_block', 'outdated_managed_block', 'missing_generated_file', 'outdated_generated_file'].includes(finding.reason)
      || finding.agentFile === null) continue;
    const root = finding.repositoryRoot;
    const bindingPath = path.join(root, '.kiokuko.json');
    const binding = await readRegularFile(bindingPath, { containmentRoot: root });
    if (binding === undefined) throw new KiokukoError('CONFLICT', 'Project binding disappeared before agent file recovery');
    const config = parseProjectConfigText(binding.content);
    const agentPath = path.join(root, config.agentFile);
    if (config.repositoryId !== finding.repositoryId || agentPath !== finding.agentFile) {
      throw new KiokukoError('CONFLICT', 'Project binding changed before agent file recovery');
    }
    const rootIdentity = await readDirectoryIdentity(root);
    const parentIdentity = await readDirectoryIdentity(path.dirname(agentPath));
    const original = await readRegularFile(agentPath, { containmentRoot: root });
    const missing = finding.reason === 'missing_agent_file';
    // A newly created file belongs to its creator. A disappeared file needs a fresh diagnosis.
    if (missing !== (original === undefined)) continue;
    if (original !== undefined && isDshOnlyAgentFile(original.content)) continue;
    if (config.templateVersion > AGENT_TEMPLATE_VERSION) continue;
    const version = original === undefined ? undefined : readManagedBlockTemplateVersion(original.content);
    if (version !== undefined && version > AGENT_TEMPLATE_VERSION) continue;
    const rendered = renderAgentFile(original?.content, {
      repositoryId: config.repositoryId,
      workspace: config.workspace,
      cliCommand: preferredDoctorCommand(),
    });
    const generatedPath = path.join(root, GENERATED_AGENT_FILE);
    const generated = await readRegularFile(generatedPath, { containmentRoot: root });
    const generatedVersion = generated === undefined ? undefined : readManagedBlockTemplateVersion(generated.content);
    if (generatedVersion !== undefined && generatedVersion > AGENT_TEMPLATE_VERSION) continue;
    const generatedParentIdentity = await readDirectoryIdentity(path.dirname(generatedPath));
    const renderedGenerated = renderGeneratedAgentFile(generated?.content, {
      repositoryId: config.repositoryId, workspace: config.workspace, cliCommand: preferredDoctorCommand(),
    });
    if (rendered.action === 'unchanged' && renderedGenerated.action === 'unchanged') continue;
    output.write(`Doctor found ${missing ? 'a missing agent instruction file' : 'a missing or outdated Kiokuko section'}:\n  ${agentPath}\n`);
    output.write(missing
      ? 'This creates Kiokuko instructions only; deleted custom instructions cannot be restored.\n'
      : 'This updates only the Kiokuko pointer and .kiokuko/AGENTS.md managed section; user instructions and other products are preserved.\n');
    const prompt = createInterface({ input, output });
    let closed = false;
    const cancelled = new Promise<string>((resolve) => {
      prompt.once('close', () => { closed = true; resolve(''); });
    });
    let answer: string;
    try {
      answer = (await Promise.race([
        prompt.question(missing ? 'Create this missing agent file? [y/N] ' : 'Repair this Kiokuko section? [Y/n] '),
        cancelled,
      ])).trim();
      if (closed) return created;
    } finally {
      prompt.close();
    }
    if (!(answer === '' && !missing) && !/^(?:y|yes|はい)$/iu.test(answer)) continue;
    await assertFileExpectation(bindingPath, {
      expected: binding,
      containmentRoot: root,
      ...(rootIdentity === undefined ? {} : { expectedParentDirectory: rootIdentity }),
    });
    // Recheck both plans before publishing either file. Each write remains CAS-bound.
    await assertFileExpectation(agentPath, { expected: original, containmentRoot: root,
      ...(parentIdentity === undefined ? {} : { expectedParentDirectory: parentIdentity }) });
    await assertFileExpectation(generatedPath, { expected: generated, containmentRoot: root,
      ...(generatedParentIdentity === undefined ? {} : { expectedParentDirectory: generatedParentIdentity }) });
    let installedGenerated: Awaited<ReturnType<typeof atomicWriteTextIfUnchanged>> | undefined;
    let installedRoot: Awaited<ReturnType<typeof atomicWriteTextIfUnchanged>> | undefined;
    try {
      if (renderedGenerated.action !== 'unchanged') {
        try { installedGenerated = await atomicWriteTextIfUnchanged(generatedPath, renderedGenerated.content, {
          expected: generated, containmentRoot: root,
          ...(generatedParentIdentity === undefined ? {} : { expectedParentDirectory: generatedParentIdentity }),
        }, generated?.mode ?? 0o644); } catch (error) {
          if (error instanceof AtomicCommittedMutationError) installedGenerated = error.outcome;
          throw error;
        }
        assertAtomicCleanupComplete(installedGenerated);
      }
      if (rendered.action !== 'unchanged') {
        try { installedRoot = await atomicWriteTextIfUnchanged(agentPath, rendered.content, {
          expected: original, containmentRoot: root,
          ...(parentIdentity === undefined ? {} : { expectedParentDirectory: parentIdentity }),
        }, original?.mode ?? 0o644); } catch (error) {
          if (error instanceof AtomicCommittedMutationError) installedRoot = error.outcome;
          throw error;
        }
        assertAtomicCleanupComplete(installedRoot);
      }
      await assertFileExpectation(bindingPath, { expected: binding, containmentRoot: root,
        ...(rootIdentity === undefined ? {} : { expectedParentDirectory: rootIdentity }) });
      await assertFileExpectation(agentPath, { expected: installedRoot?.installed ?? original, containmentRoot: root,
        ...(parentIdentity === undefined ? {} : { expectedParentDirectory: parentIdentity }) });
      await assertFileExpectation(generatedPath, { expected: installedGenerated?.installed ?? generated, containmentRoot: root });
    } catch (error) {
      if (installedRoot !== undefined) {
        try {
          const expected = { expected: installedRoot.installed, containmentRoot: root };
          const restored = original === undefined
            ? await unlinkRegularFileIfUnchanged(agentPath, expected)
            : await atomicWriteTextIfUnchanged(agentPath, original.content, expected, original.mode);
          assertAtomicCleanupComplete(restored);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Agent repair failed; root instructions could not be safely restored');
        }
      }
      if (installedGenerated !== undefined) {
        try {
          const expected = { expected: installedGenerated.installed, containmentRoot: root };
          const restored = generated === undefined
            ? await unlinkRegularFileIfUnchanged(generatedPath, expected)
            : await atomicWriteTextIfUnchanged(generatedPath, generated.content, expected, generated.mode);
          assertAtomicCleanupComplete(restored);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Agent repair failed; generated instructions could not be safely restored');
        }
      }
      throw error;
    }
    output.write(`${missing ? 'Created' : 'Repaired'} ${agentPath}\n`);
    created += 1;
  }
  return created;
}

/** Compatibility entry point for callers that request missing-file restoration only. */
export async function promptRecreateMissingAgentFiles(
  findings: readonly DoctorAgentFileFinding[],
  options: DoctorPromptOptions = {},
): Promise<number> {
  return promptRepairAgentFiles(findings.filter((finding) => finding.reason === 'missing_agent_file'), options);
}

/** Ask before removing registry rows for repository roots that no longer exist. */
export async function promptRemoveMissingRepositoryLocations(
  locations: readonly RepositoryLocation[],
  options: DoctorPromptOptions = {},
): Promise<boolean> {
  if (locations.length < 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'Missing repository locations must not be empty');
  }
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  const prompt = createInterface({ input, output });
  try {
    const count = locations.length;
    output.write(
      `Doctor found ${count} repository location${count === 1 ? '' : 's'} with a missing root. `
      + 'The following registry rows are candidates:\n',
    );
    for (const location of locations.slice(0, MAX_DOCTOR_PROMPT_LOCATIONS)) {
      output.write(`  - ${location.canonicalRoot}\n`);
    }
    if (locations.length > MAX_DOCTOR_PROMPT_LOCATIONS) {
      output.write(`  ... and ${locations.length - MAX_DOCTOR_PROMPT_LOCATIONS} more\n`);
    }
    output.write('This removes registry rows only; it does not delete files or memory.\n');
    const answer = (await prompt.question('Remove these stale locations? [Y/n] ')).trim();
    return answer.length === 0 || /^(?:y|yes|はい)$/iu.test(answer);
  } finally {
    prompt.close();
  }
}

function count(database: SqliteDatabase, sql: string, ...parameters: Array<string | number>): number {
  return Number(database.prepare(sql).get<{ count: number }>(...parameters)?.count ?? 0);
}

function preferredDoctorCommand(): 'kiokuko' | 'npm exec -- kiokuko' {
  return process.env.npm_command === 'exec' || process.env.npm_lifecycle_event === 'npx'
    ? 'npm exec -- kiokuko'
    : 'kiokuko';
}

/** Inspect the Codex MCP identity using the same canonical parser as setup. */
async function codexMcpCheck(): Promise<DoctorCheck> {
  let config;
  try {
    config = await readRegularFile(getCodexConfigPath());
  } catch {
    return { ok: false, count: 1, detail: 'config=unavailable' };
  }
  if (config === undefined) return { ok: true, count: 0, detail: 'config=absent' };
  try {
    // Rendering is intentionally discarded: it validates the existing identity
    // without writing, and accepts configs that simply have not been configured.
    renderCodexMcpConfig(config.content);
    return { ok: true, count: 0, detail: 'config=canonical-or-not-configured' };
  } catch (error) {
    if (setupMcpIdentityConflictClient(error) === 'codex') {
      return { ok: false, count: 1, detail: 'config=conflict' };
    }
    return { ok: false, count: 1, detail: 'config=invalid' };
  }
}

function skippedCodexMcpCheck(): DoctorCheck {
  return { ok: true, count: 0, detail: 'config=skipped-for-explicit-database' };
}

async function runtimeCheck(databasePath: string, descriptorPath = getRuntimeDescriptorPath()): Promise<DoctorCheck> {
  let findings = 0;
  let descriptor: Awaited<ReturnType<typeof readRuntimeDescriptor>>;
  let descriptorPresent = false;
  let lockPresent = false;
  try {
    descriptor = await readRuntimeDescriptor(descriptorPath);
    if (descriptor !== undefined) {
      const expected = `sha256:${createHash('sha256').update(path.resolve(databasePath), 'utf8').digest('hex')}`;
      // A single runtime descriptor is shared by the normal CLI/server
      // installation. It may legitimately describe another database when
      // doctor is run against an explicit backup or test database.
      if (descriptor.databaseFingerprint === expected) {
        descriptorPresent = true;
        if (!(await isPidAlive(descriptor.pid))) findings += 1;
      }
    }
  } catch {
    findings += 1;
  }

  const lockPath = getDatabaseLockPath(databasePath);
  try {
    const info = lstatSync(lockPath);
    lockPresent = true;
    if (info.isSymbolicLink() || !info.isFile() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) findings += 1;
    try {
      const value = JSON.parse(readFileSync(lockPath, 'utf8')) as { instanceId?: unknown; pid?: unknown };
      if (typeof value.instanceId !== 'string' || typeof value.pid !== 'number' || !(await isPidAlive(value.pid))) findings += 1;
      if (descriptor !== undefined && value.instanceId !== descriptor.instanceId) findings += 1;
    } catch {
      findings += 1;
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) findings += 1;
  }
  if (descriptorPresent !== lockPresent) findings += 1;
  return { ok: findings === 0, count: findings, detail: `findings=${findings}` };
}

interface DoctorCollectionOptions {
  verifyRepositories?: boolean;
  databasePath: string;
  databaseVersion: number;
  currentVersion: number;
  capabilities: DoctorResult['capabilities'];
  runtimeDescriptorPath?: string;
  embeddingEnvironment?: NodeJS.ProcessEnv;
  embeddingBackend?: VectorSearchBackend;
  codexMcp: DoctorCheck;
  hooksPath?: string;
}

async function collectDoctorResult(
  database: SqliteDatabase,
  options: DoctorCollectionOptions,
): Promise<DoctorResult> {
  const integrity = database.prepare('PRAGMA integrity_check').get<{ integrity_check: string }>()?.integrity_check ?? 'unknown';
  const foreignKeyRows = database.prepare('PRAGMA foreign_key_check').all();
  const fts5 = Boolean(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'entries_fts'").get());
  const migrationRows = count(database, 'SELECT COUNT(*) AS count FROM schema_migrations');
  const migrationCheck = { ok: migrationRows === options.currentVersion, count: migrationRows, detail: `expected ${options.currentVersion}` };

  const entryCount = count(database, 'SELECT COUNT(*) AS count FROM entries');
  const ftsCount = fts5 ? count(database, 'SELECT COUNT(*) AS count FROM entries_fts') : 0;
  let ftsCurrentMismatches = 0;
  if (fts5) {
    const currentRows = database.prepare(`
      SELECT e.rowid, e.id, r.title, r.body, r.summary, e.current_revision
        FROM entries e JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision
    `).all<{ rowid: number; id: string; title: string; body: string; summary: string | null; current_revision: number }>();
    for (const row of currentRows) {
      const projected = database.prepare('SELECT title, body, summary, tags_text FROM entries_fts WHERE rowid = ?').get<{ title: string; body: string; summary: string; tags_text: string }>(row.rowid);
      const tags = database.prepare('SELECT tag FROM entry_revision_tags WHERE entry_id = ? AND revision = ? ORDER BY tag').all<{ tag: string }>(row.id, row.current_revision).map((tag) => tag.tag);
      if (!projected || projected.title !== row.title || projected.body !== row.body || projected.summary !== (row.summary ?? '') || projected.tags_text !== tags.join(' ')) ftsCurrentMismatches += 1;
    }
  }
  const ftsCheck = {
    ok: fts5 && entryCount === ftsCount && ftsCurrentMismatches === 0,
    count: Math.abs(entryCount - ftsCount) + ftsCurrentMismatches + (fts5 ? 0 : 1),
    detail: `present=${fts5}, entries=${entryCount}, fts=${ftsCount}, currentMismatches=${ftsCurrentMismatches}`,
  };
  const missingCurrentRevisions = count(database, `
    SELECT COUNT(*) AS count FROM entries e
    LEFT JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision
    WHERE r.entry_id IS NULL
  `);
  const orphanRevisionTags = count(database, `
    SELECT COUNT(*) AS count FROM entry_revision_tags t
    LEFT JOIN entry_revisions r ON r.entry_id = t.entry_id AND r.revision = t.revision
    WHERE r.entry_id IS NULL
  `);
  const missingDeliveryRevisions = count(database, `
    SELECT COUNT(*) AS count FROM context_delivery_entries d
    LEFT JOIN entry_revisions r ON r.entry_id = d.entry_id AND r.revision = d.entry_revision
    WHERE r.entry_id IS NULL
  `);
  const revisionRows = database.prepare(`
    SELECT r.entry_id, r.workspace, r.revision
      FROM entry_revisions AS r
  `).all<{ entry_id: string; workspace: string; revision: number }>();
  const hashFormatTable = database.prepare(`
    SELECT type
      FROM sqlite_schema
     WHERE name = 'entry_revision_hash_format'
  `).get<{ type: unknown }>();
  const hashFormats = hashFormatTable?.type === 'table'
    ? database.prepare('SELECT singleton, algorithm FROM entry_revision_hash_format')
      .all<{ singleton: unknown; algorithm: unknown }>()
    : [];
  let revisionHashMismatches = 0;
  revisionHashMismatches = hashFormats.length === 1
    && hashFormats[0]?.singleton === 1
    && hashFormats[0].algorithm === 'canonical-json-utf16-tags-v1'
    ? 0
    : 1;
  for (const row of revisionRows) {
    try {
      // The shared decoder accepts only the canonical JSON preimage and the
      // single locale-independent revision hash format.
      readEntryRevision(database, {
        entryId: row.entry_id,
        workspace: row.workspace,
        revision: row.revision,
      });
    } catch (error) {
      if (error instanceof KiokukoError && error.code === 'INTEGRITY_ERROR') {
        revisionHashMismatches += 1;
        continue;
      }
      throw error;
    }
  }

  const revisionHashCheck = { ok: revisionHashMismatches === 0, count: revisionHashMismatches };
  const hybridCheck = (() => {
    try {
      const projection = hybridSearchProjectionStatus(database);
      return {
        ok: projection.missingSignals === 0 && projection.extraSignals === 0 && projection.staleTrigram === 0,
        count: projection.missingSignals + projection.extraSignals + projection.staleTrigram,
        detail: `entries=${projection.entries}, trigram=${projection.trigram}, signals=${projection.signals}, missingSignals=${projection.missingSignals}, extraSignals=${projection.extraSignals}, staleTrigram=${projection.staleTrigram}`,
      };
    } catch (error) {
      if (error instanceof KiokukoError && error.code === 'INTEGRITY_ERROR') {
        return { ok: false, count: 1, detail: 'stored projection source is invalid' };
      }
      throw error;
    }
  })();
  const danglingLinks = count(database, `
    SELECT COUNT(*) AS count FROM entry_links l
    LEFT JOIN entries f ON f.id = l.from_entry_id
    LEFT JOIN entries t ON t.id = l.to_entry_id
    WHERE f.id IS NULL OR t.id IS NULL
  `);
  const contradictions = count(database, `
    SELECT COUNT(*) AS count FROM entry_links l
    JOIN entries f ON f.id = l.from_entry_id
    JOIN entries t ON t.id = l.to_entry_id
    WHERE l.relation = 'contradicts' AND f.status = 'verified' AND t.status = 'verified'
  `);

  const bindingRows = listRepositoryLocations(database);
  const missingRoots = bindingRows.filter((row) => !existsSync(row.canonicalRoot)).length;
  const bindingCheck = { ok: missingRoots === 0, status: missingRoots === 0 ? 'ok' as const : 'attention' as const, count: missingRoots, detail: `locations=${bindingRows.length}` };

  const agentFileFindings: DoctorAgentFileFinding[] = [];
  for (const row of bindingRows) {
    if (!existsSync(row.canonicalRoot)) continue;
    const configPath = path.join(row.canonicalRoot, '.kiokuko.json');
    let agentPath: string | null = null;
    try {
      const binding = await readRegularFile(configPath, { containmentRoot: row.canonicalRoot });
      if (binding === undefined) {
        agentFileFindings.push({ repositoryRoot: row.canonicalRoot, repositoryId: row.repositoryId,
          agentFile: null, bindingFile: configPath, reason: 'missing_binding_file',
          detail: 'This location is registered, but its project binding file is missing. Binding identity is unverified; this does not establish memory corruption.',
          action: `Restore .kiokuko.json from this project's backup with repositoryId ${row.repositoryId}, then rerun kiokuko doctor. Do not create a new binding identity for the existing memory.`,
        });
        continue;
      }
      const config = parseProjectConfigText(binding.content);
      if (config.repositoryId !== row.repositoryId) throw new KiokukoError('CONFLICT', 'Project binding identity differs from registration');
      agentPath = path.join(row.canonicalRoot, config.agentFile);
      const agent = await readRegularFile(agentPath, { containmentRoot: row.canonicalRoot });
      let reason: DoctorAgentFileFinding['reason'] | undefined;
      if (agent === undefined) reason = 'missing_agent_file';
      else {
        try {
          if (isDshOnlyAgentFile(agent.content)) continue;
          const version = readManagedBlockTemplateVersion(agent.content);
          if (config.templateVersion > AGENT_TEMPLATE_VERSION || (version !== undefined && version > AGENT_TEMPLATE_VERSION)) {
            reason = 'invalid_managed_block';
          } else if (version === undefined) reason = 'missing_managed_block';
          else if (renderAgentFile(agent.content, {
            repositoryId: config.repositoryId,
            workspace: config.workspace,
            cliCommand: preferredDoctorCommand(),
          }).action !== 'unchanged') reason = 'outdated_managed_block';
          else {
            const generatedPath = path.join(row.canonicalRoot, GENERATED_AGENT_FILE);
            const generated = await readRegularFile(generatedPath, { containmentRoot: row.canonicalRoot });
            if (generated === undefined) reason = 'missing_generated_file';
            else {
              const generatedVersion = readManagedBlockTemplateVersion(generated.content);
              if (generatedVersion !== undefined && generatedVersion > AGENT_TEMPLATE_VERSION) reason = 'invalid_managed_block';
              else if (renderGeneratedAgentFile(generated.content, {
                repositoryId: config.repositoryId, workspace: config.workspace, cliCommand: preferredDoctorCommand(),
              }).action !== 'unchanged') reason = 'outdated_generated_file';
            }
          }
        } catch (error) {
          if (!(error instanceof KiokukoError && error.code === 'VALIDATION_ERROR')) throw error;
          reason = 'invalid_managed_block';
        }
      }
      if (reason !== undefined) {
        agentFileFindings.push({
          repositoryRoot: row.canonicalRoot,
          repositoryId: row.repositoryId,
          agentFile: agentPath,
          reason,
        });
      }
    } catch (error) {
      const diagnostic = diagnosticError(error);
      agentFileFindings.push({
        repositoryRoot: row.canonicalRoot,
        repositoryId: row.repositoryId,
        agentFile: agentPath,
        reason: agentPath === null ? 'invalid_binding' : 'unreadable_agent_file',
        ...(agentPath === null ? { bindingFile: configPath,
          detail: `${diagnostic.code}: ${diagnostic.message}`,
          action: 'Correct the reported binding file or restore its original contents from backup, preserving the registered repository identity, then rerun kiokuko doctor.',
        } : {}),
      });
    }
  }
  const agentFilesStatus = agentFileFindings.length === 0 ? 'ok' as const
    : agentFileFindings.every(finding => ['missing_binding_file', 'missing_agent_file', 'missing_managed_block', 'outdated_managed_block', 'missing_generated_file', 'outdated_generated_file'].includes(finding.reason))
      ? 'attention' as const : 'failed' as const;
  const agentFilesCheck = { ok: agentFileFindings.length === 0, status: agentFilesStatus, count: agentFileFindings.length, findings: agentFileFindings };

  let secretCount = 0;
  const secretRows = database.prepare(`
    SELECT r.title, r.body, r.summary, r.scope_json, r.provenance_json
      FROM entries e JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision
  `).all<{ title: string; body: string; summary: string | null; scope_json: string; provenance_json: string }>();
  for (const row of secretRows) {
    if (findSecret(`${row.title}\n${row.body}\n${row.summary ?? ''}\n${row.scope_json}\n${row.provenance_json}`)) secretCount += 1;
  }
  const permissions = (() => {
    try {
      const mode = statSync(options.databasePath).mode & 0o777;
      return { ok: (mode & 0o077) === 0, count: mode, detail: `mode=${mode.toString(8)}` };
    } catch {
      return { ok: false, count: 0, detail: 'database file is not accessible' };
    }
  })();

  const ledgerReport = inspectLedger(database);
  const ledgerCheck = { ok: ledgerReport.ok, count: ledgerReport.findingCount, detail: `findings=${ledgerReport.findingCount}` };
  const nudgeDeliveries = {
    ok: ledgerReport.checks.nudgeDeliveries.ok,
    count: ledgerReport.checks.nudgeDeliveries.findingCount,
    detail: `deliveries=${ledgerReport.counts.nudgeDeliveries}, findings=${ledgerReport.checks.nudgeDeliveries.findingCount}`,
  };
  const runtime = await runtimeCheck(options.databasePath, options.runtimeDescriptorPath);
  const embeddings = inspectEmbeddingHealth(
    database,
    options.embeddingEnvironment ?? readPersistedEmbeddingSettings(database),
    options.embeddingBackend,
  );
  const checks = {
    integrity: { ok: integrity === 'ok', detail: integrity },
    foreignKeys: { ok: foreignKeyRows.length === 0, count: foreignKeyRows.length },
    entryRevisions: { ok: missingCurrentRevisions === 0, count: missingCurrentRevisions },
    revisionTags: { ok: orphanRevisionTags === 0, count: orphanRevisionTags },
    deliveryRevisions: { ok: missingDeliveryRevisions === 0, count: missingDeliveryRevisions },
    revisionHashes: revisionHashCheck,
    migrations: migrationCheck,
    fts: ftsCheck,
    danglingLinks: { ok: danglingLinks === 0, count: danglingLinks },
    contradictions: { ok: contradictions === 0, count: contradictions, detail: 'verified contradictions require review' },
    bindings: bindingCheck,
    agentFiles: agentFilesCheck,
    permissions,
    secrets: { ok: secretCount === 0, count: secretCount },
    ledger: ledgerCheck,
    nudgeDeliveries,
    runtime,
    hybridSearch: hybridCheck,
    embeddings: embeddings.check,
    codexMcp: options.codexMcp,
    memoryAssurance: assuranceDoctor(database, options.hooksPath, options.verifyRepositories),
  };
  const ok = Object.values(checks).every((check) => check.ok);
  const status = ok ? 'ok' as const : Object.values(checks).some((check: DoctorCheck) => !check.ok && check.status !== 'attention') ? 'failed' as const : 'attention' as const;
  return {
    ok,
    status,
    databasePath: '<redacted>',
    currentVersion: options.currentVersion,
    capabilities: options.capabilities,
    integrity,
    fts5,
    checks,
  };
}

export async function runDoctor(
  options: DoctorOptions = {},
  dependencies: DoctorDependencies = {},
): Promise<DoctorResult> {
  const initOptions = {
    ...(options.databasePath === undefined ? {} : { databasePath: options.databasePath }),
    ...(options.migrationsDirectory === undefined ? {} : { migrationsDirectory: options.migrationsDirectory }),
  };
  const initialized = await initializeDatabase(initOptions);
  const codexMcp = options.databasePath === undefined ? await codexMcpCheck() : skippedCodexMcpCheck();
  let embeddingConfig;
  try {
    embeddingConfig = options.embeddingEnvironment === undefined
      ? undefined
      : parseEmbeddingConfig(options.embeddingEnvironment);
  } catch {
    embeddingConfig = undefined;
  }
  let opened: { database: SqliteDatabase; backend: VectorSearchBackend | undefined };
  try {
    opened = await openEmbeddingDatabase(initialized.databasePath, {
      ...(embeddingConfig === undefined ? {} : { config: embeddingConfig }),
      openDatabase: dependencies.openConnection ?? openConnection,
      ...(options.embeddingBackend === undefined ? {} : { backend: options.embeddingBackend }),
    });
  } catch (error) {
    if (!(error instanceof EmbeddingBackendUnavailableError)) throw error;
    opened = {
      database: (dependencies.openConnection ?? openConnection)(initialized.databasePath),
      backend: undefined,
    };
  }
  const database = opened.database;
  let doctorResult: DoctorResult | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    doctorResult = await collectDoctorResult(database, {
      databasePath: initialized.databasePath,
      databaseVersion: initialized.currentVersion,
      currentVersion: initialized.currentVersion,
      capabilities: initialized.capabilities,
      ...(options.runtimeDescriptorPath === undefined ? {} : { runtimeDescriptorPath: options.runtimeDescriptorPath }),
      ...(options.embeddingEnvironment === undefined ? {} : { embeddingEnvironment: options.embeddingEnvironment }),
      ...((opened.backend ?? options.embeddingBackend) === undefined
        ? {}
        : { embeddingBackend: opened.backend ?? options.embeddingBackend }),
      codexMcp,
      ...(options.verifyRepositories === undefined ? {} : { verifyRepositories: options.verifyRepositories }),
      ...(options.databasePath === undefined ? { hooksPath: path.join(path.dirname(getCodexConfigPath()), 'hooks.json') } : {}),
    });
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    database.close();
  } catch (closeError) {
    if (operationFailed) {
      throw new AggregateError(
        [operationError, closeError],
        'Doctor checks failed and closing the database connection also failed',
      );
    }
    throw closeError;
  }
  if (operationFailed) throw operationError;
  if (doctorResult === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Doctor checks produced no result');
  }
  return doctorResult;
}
