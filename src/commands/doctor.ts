import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { initializeDatabase } from './init.js';
import { openConnection } from '../db/connection.js';
import { BEGIN_MARKER, END_MARKER } from '../agent-file/managed-block.js';
import { readProjectConfig } from '../config/project-config.js';
import { getDatabaseLockPath, getRuntimeDescriptorPath } from '../config/paths.js';
import { isPidAlive } from '../server/instance-lock.js';
import { readRuntimeDescriptor } from '../server/runtime-descriptor.js';
import { inspectLedger } from '../ledger/maintenance.js';
import { findSecret } from '../memory/secrets.js';
import { hybridSearchProjectionStatus } from '../memory/rebuild-search.js';
import { canonicalContentHash } from '../serialization/validate.js';

export interface DoctorCheck {
  ok: boolean;
  count?: number;
  detail?: string;
}

export interface DoctorResult {
  ok: boolean;
  databasePath: string;
  currentVersion: number;
  capabilities: Awaited<ReturnType<typeof initializeDatabase>>['capabilities'];
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
    agentFiles: DoctorCheck;
    permissions: DoctorCheck;
    secrets: DoctorCheck;
    ledger: DoctorCheck;
    runtime: DoctorCheck;
    hybridSearch: DoctorCheck;
  };
}

function count(database: ReturnType<typeof openConnection>, sql: string, ...parameters: string[]): number {
  return Number(database.prepare(sql).get<{ count: number }>(...parameters)?.count ?? 0);
}

function balancedMarkers(content: string): boolean {
  return content.split(BEGIN_MARKER).length - 1 === 1 && content.split(END_MARKER).length - 1 === 1;
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

export async function runDoctor(options: { databasePath?: string; runtimeDescriptorPath?: string } = {}): Promise<DoctorResult> {
  const initialized = await initializeDatabase(options);
  const database = openConnection(initialized.databasePath);
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get<{ integrity_check: string }>()?.integrity_check ?? 'unknown';
    const foreignKeyRows = database.prepare('PRAGMA foreign_key_check').all();
    const fts5 = Boolean(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'entries_fts'").get());
    const migrationRows = count(database, 'SELECT COUNT(*) AS count FROM schema_migrations');
    const expectedMigrations = initialized.currentVersion;
    const migrationCheck = { ok: migrationRows === expectedMigrations, count: migrationRows, detail: `expected ${expectedMigrations}` };

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
    const ftsCheck = { ok: !fts5 || (entryCount === ftsCount && ftsCurrentMismatches === 0), count: Math.abs(entryCount - ftsCount) + ftsCurrentMismatches, detail: `entries=${entryCount}, fts=${ftsCount}, currentMismatches=${ftsCurrentMismatches}` };
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
      SELECT r.entry_id, r.revision, r.kind, r.title, r.body, r.summary,
             r.scope_json, r.provenance_json, r.content_hash
        FROM entry_revisions AS r
    `).all<{ entry_id: string; revision: number; kind: string; title: string; body: string; summary: string | null; scope_json: string; provenance_json: string; content_hash: string }>();
    let revisionHashMismatches = 0;
    for (const row of revisionRows) {
      try {
        const tags = database.prepare('SELECT tag FROM entry_revision_tags WHERE entry_id = ? AND revision = ? ORDER BY tag').all<{ tag: string }>(row.entry_id, row.revision).map((tag) => tag.tag);
        const expected = canonicalContentHash({ kind: row.kind, title: row.title, body: row.body, summary: row.summary, scope: JSON.parse(row.scope_json), provenance: JSON.parse(row.provenance_json), tags });
        if (expected !== row.content_hash) revisionHashMismatches += 1;
      } catch {
        revisionHashMismatches += 1;
      }
    }
    const projection = hybridSearchProjectionStatus(database);
    const hybridCheck = {
      ok: projection.missingSignals === 0 && projection.extraSignals === 0 && projection.staleTrigram === 0,
      count: projection.missingSignals + projection.extraSignals + projection.staleTrigram,
      detail: `entries=${projection.entries}, trigram=${projection.trigram}, signals=${projection.signals}, missingSignals=${projection.missingSignals}, extraSignals=${projection.extraSignals}, staleTrigram=${projection.staleTrigram}`,
    };
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

    const bindingRows = database.prepare('SELECT repository_id, canonical_root FROM repository_locations ORDER BY canonical_root').all<{ repository_id: string; canonical_root: string }>();
    const missingRoots = bindingRows.filter((row) => !existsSync(row.canonical_root)).length;
    const bindingCheck = { ok: missingRoots === 0, count: missingRoots, detail: `locations=${bindingRows.length}` };

    let missingAgentFiles = 0;
    for (const row of bindingRows) {
      if (!existsSync(row.canonical_root)) continue;
      const configPath = `${row.canonical_root}/.kiokuko.json`;
      try {
        const config = await readProjectConfig(configPath);
        const agentPath = `${row.canonical_root}/${config.agentFile}`;
        if (!existsSync(agentPath) || !balancedMarkers(readFileSync(agentPath, 'utf8'))) missingAgentFiles += 1;
      } catch {
        missingAgentFiles += 1;
      }
    }
    const agentFilesCheck = { ok: missingAgentFiles === 0, count: missingAgentFiles };

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
        const mode = statSync(initialized.databasePath).mode & 0o777;
        return { ok: (mode & 0o077) === 0, count: mode, detail: `mode=${mode.toString(8)}` };
      } catch {
        return { ok: false, count: 0, detail: 'database file is not accessible' };
      }
    })();

    const ledgerReport = inspectLedger(database);
    const ledgerCheck = { ok: ledgerReport.ok, count: ledgerReport.findingCount, detail: `findings=${ledgerReport.findingCount}` };
    const runtime = await runtimeCheck(initialized.databasePath, options.runtimeDescriptorPath);
    const checks = {
      integrity: { ok: integrity === 'ok', detail: integrity },
      foreignKeys: { ok: foreignKeyRows.length === 0, count: foreignKeyRows.length },
      entryRevisions: { ok: missingCurrentRevisions === 0, count: missingCurrentRevisions },
      revisionTags: { ok: orphanRevisionTags === 0, count: orphanRevisionTags },
      deliveryRevisions: { ok: missingDeliveryRevisions === 0, count: missingDeliveryRevisions },
      revisionHashes: { ok: revisionHashMismatches === 0, count: revisionHashMismatches },
      migrations: migrationCheck,
      fts: ftsCheck,
      danglingLinks: { ok: danglingLinks === 0, count: danglingLinks },
      contradictions: { ok: contradictions === 0, count: contradictions, detail: 'verified contradictions require review' },
      bindings: bindingCheck,
      agentFiles: agentFilesCheck,
      permissions,
      secrets: { ok: secretCount === 0, count: secretCount },
      ledger: ledgerCheck,
      runtime,
      hybridSearch: hybridCheck,
    };
    const ok = Object.values(checks).every((check) => check.ok);
    return { ok, databasePath: '<redacted>', currentVersion: initialized.currentVersion, capabilities: initialized.capabilities, integrity, fts5, checks };
  } finally {
    database.close();
  }
}
