import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { canonicalContentHash } from '../../src/serialization/validate.js';
import { repositoryStateDigest } from '../../src/assurance/snapshot.js';

test('installed hook upgrades schema 11 before completing an admitted active call, without replaying execution', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'kiokuko-hook-upgrade-'));
  const root = realpathSync(base);
  const oldMigrations = path.join(root, 'old-migrations');
  mkdirSync(oldMigrations);
  for (const file of readdirSync('migrations').filter(file => /^0(0\d|1[01])_.*\.sql$/u.test(file))) {
    copyFileSync(path.join('migrations', file), path.join(oldMigrations, file));
  }
  const databasePath = path.join(root, 'memory.sqlite3');
  await initializeDatabase({ databasePath, migrationsDirectory: oldMigrations });
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
  execFileSync('git', ['-C', root, 'commit', '--allow-empty', '-qm', 'fixture']);
  const event = { hook_event_name: 'PostToolUse', session_id: 'session', turn_id: 'turn', cwd: root,
    tool_name: 'exec_command', tool_use_id: 'call', tool_input: { cmd: 'already executed' }, tool_response: 'exit_code: 0' };
  const identity = canonicalContentHash({ session: 'session', turn: 'turn', agent: 'main', root });
  const cli = (input: unknown, db = databasePath) => spawnSync(process.execPath,
    ['--import', 'tsx', 'src/bin/kiokuko.ts', 'codex-hook', '--database', db], { input: JSON.stringify(input), encoding: 'utf8', cwd: process.cwd() });
  let db = openConnection(databasePath);
  try {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ledger_runs(run_id,workspace,client_kind,protocol_version,capture_profile,coverage_json,status,metadata_json,started_at,created_at,updated_at)
      VALUES('active','project','codex','1','minimal','{}','active','{}',?,?,?)`).run(now, now, now);
    db.prepare("INSERT INTO task_assurance(run_id,repository_root,retrieval_status,updated_at) VALUES('active',?,'no_entries',?)").run(root, now);
    db.prepare("INSERT INTO codex_hook_requests VALUES(?,?,'active',?,'bound',0,'PreToolUse',?)").run(identity, root, `codex-${identity}`, now);
    db.close();
    // Ignore fixture artifacts so database writes cannot masquerade as repository changes.
    execFileSync('git', ['-C', root, 'config', 'core.excludesFile', '/dev/null']);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.join(root, '.git', 'info', 'exclude'), '*\n');
    const digest = repositoryStateDigest(root);
    db = openConnection(databasePath);
    db.prepare('INSERT INTO codex_hook_tools VALUES(?,?,?,NULL,?,?,NULL,NULL)').run(identity, 'call', 'active', canonicalContentHash(event.tool_input), digest);
    db.close();
    const malformed = cli({ ...event, session_id: '' });
    assert.equal(malformed.status, 2);
    db = openConnection(databasePath);
    assert.equal(db.prepare('SELECT MAX(version) v FROM schema_migrations').get()?.v, 11);
    db.close();
    const completed = cli(event);
    assert.equal(completed.status, 0, completed.stderr);
    assert.deepEqual(JSON.parse(completed.stdout), {});
    assert.equal(cli(event).status, 0);
    db = openConnection(databasePath);
    assert.equal(db.prepare('SELECT MAX(version) v FROM schema_migrations').get()?.v, 12);
    assert.equal(db.prepare("SELECT status FROM ledger_runs WHERE run_id='active'").get()?.status, 'active');
    assert.equal(db.prepare("SELECT unknown_exit_calls FROM task_execution_observations WHERE run_id='active'").get()?.unknown_exit_calls, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM task_execution_evidence').get()?.n, 0);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.prepare("UPDATE schema_migrations SET checksum='tampered' WHERE version=12").run();
    db.close();
    assert.equal(cli(event).status, 2, 'invalid migration history must fail closed');
    const absent = path.join(root, 'absent.sqlite3');
    assert.equal(cli(event, absent).status, 2);
    assert.equal(existsSync(absent), false, 'a hook must not create a replacement database');
  } finally {
    try { db.close(); } catch { /* Fixture may have closed it before invoking the real CLI. */ }
    rmSync(root, { recursive: true, force: true });
  }
});
