import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openConnection } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { exportWorkspace, writeExport } from '../../src/commands/export.js';
import { importWorkspace } from '../../src/commands/import.js';
import { recordEntry } from '../../src/memory/entries.js';
import { linkEntries, promoteEntry } from '../../src/memory/lifecycle.js';
import { createBackup } from '../../src/commands/backup.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { AgentGatewayService } from '../../src/gateway/agent-service.js';
import { createRuntimeDescriptor, writeRuntimeDescriptor } from '../../src/server/runtime-descriptor.js';

async function database(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-${prefix}-`));
  const databasePath = path.join(directory, 'kiokuko.sqlite3');
  const db = openConnection(databasePath);
  migrateDatabase(db);
  return { db, databasePath, directory };
}

test('export/import round-trips entries, tags, links, and audit deterministically', async () => {
  const source = await database('export-source');
  const target = await database('export-target');
  const exportPath = path.join(source.directory, 'memory.jsonl');
  try {
    const first = recordEntry(source.db, {
      workspace: 'project:export',
      kind: 'decision',
      title: 'SQLite driver',
      body: 'Use the standard driver.',
      tags: ['db', 'verified'],
      provenance: { type: 'document', reference: 'docs/database.md' },
    });
    const second = recordEntry(source.db, {
      workspace: 'project:export',
      kind: 'lesson',
      title: 'Locking',
      body: 'Use bounded retry.',
      tags: ['db'],
    });
    promoteEntry(source.db, { workspace: 'project:export', entryId: first.id, expectedRevision: 1 });
    linkEntries(source.db, { workspace: 'project:export', fromEntryId: second.id, toEntryId: first.id, relation: 'derived_from' });
    const exported = await writeExport(source.db, { workspace: 'project:export', output: exportPath });
    await importWorkspace(target.db, { input: exportPath });
    const imported = exportWorkspace(target.db, { workspace: 'project:export' });
    assert.equal(imported.content, exported.content);
    assert.equal(imported.count, 2);
    const duplicate = await importWorkspace(target.db, { input: exportPath });
    assert.deepEqual(duplicate, { count: 2, imported: 0, duplicates: 2, dryRun: false, workspace: 'project:export' });
    const dryRun = await importWorkspace(target.db, { input: exportPath, dryRun: true });
    assert.deepEqual(dryRun, { count: 2, imported: 0, duplicates: 2, dryRun: true, workspace: 'project:export' });
    assert.equal((await readFile(exportPath, 'utf8')).startsWith('{"sha256":"'), true);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test('import rejects checksum corruption without mutating the database', async () => {
  const source = await database('export-corrupt-source');
  const target = await database('export-corrupt-target');
  const exportPath = path.join(source.directory, 'memory.jsonl');
  const corruptPath = path.join(source.directory, 'corrupt.jsonl');
  try {
    recordEntry(source.db, { workspace: 'project:corrupt', kind: 'fact', title: 'Fact', body: 'Original' });
    await writeExport(source.db, { workspace: 'project:corrupt', output: exportPath });
    const content = await readFile(exportPath, 'utf8');
    await import('node:fs/promises').then(({ writeFile }) => writeFile(corruptPath, content.replace('Original', 'Changed')));
    await assert.rejects(importWorkspace(target.db, { input: corruptPath, dryRun: true }), /checksum/i);
    assert.equal(target.db.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 0);
  } finally {
    source.db.close();
    target.db.close();
  }
});

test('doctor reports integrity, migration, FTS, and permissions checks', async () => {
  const data = await database('doctor');
  try {
    const result = await runDoctorWithDatabase(data.databasePath, path.join(data.directory, 'runtime', 'server.json'));
    assert.equal(result.ok, true);
    assert.equal(result.checks.integrity.ok, true);
    assert.equal(result.checks.migrations.ok, true);
    assert.equal(result.checks.fts.ok, true);
    assert.equal(result.checks.permissions.ok, true);
  } finally {
    data.db.close();
  }
});

test('doctor uses canonical locale-aware tag ordering for revision hashes', async () => {
  const data = await database('doctor-revision-hash-tags');
  try {
    recordEntry(data.db, {
      workspace: 'project:doctor-hash-tags',
      kind: 'fact',
      title: 'Canonical tag ordering',
      body: 'Mixed-case tags must hash consistently.',
      tags: ['MCP', 'agent-checkpoint', 'context'],
    });

    const result = await runDoctorWithDatabase(data.databasePath, path.join(data.directory, 'runtime', 'server.json'));

    assert.equal(result.checks.revisionHashes.ok, true);
    assert.equal(result.checks.revisionHashes.count, 0);
  } finally {
    data.db.close();
  }
});

test('doctor adds content-free ledger and stale runtime findings', async () => {
  const data = await database('doctor-ledger-runtime');
  const runtimeHome = path.join(data.directory, 'doctor-runtime');
  const runtimeDescriptorPath = path.join(runtimeHome, 'server.json');
  const secretToken = 'b'.repeat(64);
  try {
    const service = new AgentGatewayService(data.db, { now: () => '2026-08-20T00:00:00.000Z' });
    const opened = service.openRun({
      idempotencyKey: 'doctor-open',
      request: {
        apiVersion: '1', workspace: 'project:doctor', client: { kind: 'doctor-test' },
        task: { title: 'doctor', query: 'doctor', profileHints: { taskType: 'build', target: 'src', expected: 'healthy' } },
        captureProfile: 'standard', coverage: { run: 'complete', tool: 'complete', command: 'complete', file: 'complete', approval: 'complete' }, metadata: {},
      },
    });
    data.db.prepare("UPDATE ledger_events SET event_hash = '0' WHERE run_id = ? AND sequence = 1").run(opened.runId);
    await writeRuntimeDescriptor(runtimeDescriptorPath, createRuntimeDescriptor({
      databasePath: data.databasePath,
      baseUrl: 'http://127.0.0.1:1',
      pid: 999999,
      instanceId: '123e4567-e89b-12d3-a456-426614174198',
      capabilityToken: secretToken,
    }));
    const result = await runDoctor({ databasePath: data.databasePath, runtimeDescriptorPath });
    assert.equal(result.ok, false);
    assert.equal(result.checks.ledger.ok, false);
    assert.equal(result.checks.runtime.ok, false);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(data.databasePath), false);
    assert.equal(serialized.includes(secretToken), false);
    assert.equal(serialized.includes(runtimeHome), false);
  } finally {
    await rm(runtimeHome, { recursive: true, force: true });
    data.db.close();
  }
});


async function runDoctorWithDatabase(databasePath: string, runtimeDescriptorPath?: string) {
  const previous = process.env.KIOKUKO_DATABASE;
  process.env.KIOKUKO_DATABASE = databasePath;
  try {
    return await runDoctor({ databasePath, ...(runtimeDescriptorPath === undefined ? {} : { runtimeDescriptorPath }) });
  } finally {
    if (previous === undefined) delete process.env.KIOKUKO_DATABASE;
    else process.env.KIOKUKO_DATABASE = previous;
  }
}

test('backup uses SQLite backup API and creates a readable copy', async () => {
  const source = await database('backup');
  const backupPath = path.join(source.directory, 'backup.sqlite3');
  try {
    recordEntry(source.db, { workspace: 'project:backup', kind: 'reference', title: 'Backup', body: 'Consistent snapshot' });
    const result = await sourceBackup(source.databasePath, backupPath);
    assert.equal(result.output, backupPath);
    const backup = openConnection(backupPath);
    try {
      assert.equal(backup.prepare('PRAGMA integrity_check').get<{ integrity_check: string }>()?.integrity_check, 'ok');
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM entries').get<{ count: number }>()?.count, 1);
    } finally {
      backup.close();
    }
  } finally {
    source.db.close();
  }
});

async function sourceBackup(databasePath: string, output: string) {
  const previous = process.env.KIOKUKO_DATABASE;
  process.env.KIOKUKO_DATABASE = databasePath;
  try {
    return await createBackup(output, databasePath);
  } finally {
    if (previous === undefined) delete process.env.KIOKUKO_DATABASE;
    else process.env.KIOKUKO_DATABASE = previous;
  }
}
