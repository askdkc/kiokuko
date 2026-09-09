import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { databaseFileIdentity, openConnection } from '../../src/db/connection.js';
import { inspectDatabaseWithoutSideEffects } from '../../src/db/inspection-snapshot.js';
import { KiokukoError } from '../../src/errors.js';

function fixture() {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'kiokuko-inspection-race-'));
  const source = path.join(directory, 'source.sqlite3');
  let writer: ReturnType<typeof openConnection> | undefined = openConnection(source);
  writer.exec('CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES (\'checkpointed\');');
  writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  writer.exec("INSERT INTO sentinel VALUES ('in WAL')");
  assert.ok(fs.statSync(`${source}-wal`).size > 0);
  const identity = databaseFileIdentity(source);
  const closeWriter = () => { writer?.close(); writer = undefined; };
  return { directory, source, identity, closeWriter };
}

test('WAL disappearing at copy time retries the whole snapshot and retains checkpointed writes', async (t) => {
  const data = fixture();
  const originalCopy = fs.copyFileSync;
  const targets: string[] = [];
  let inspections = 0;
  let afterCheckpoint: Buffer | undefined;
  t.mock.method(fs, 'copyFileSync', (source: fs.PathLike, target: fs.PathLike, flags?: number) => {
    if (source === data.source) targets.push(String(target));
    if (source === `${data.source}-wal`) {
      data.closeWriter(); // The last SQLite connection checkpoints and removes WAL/SHM.
      assert.equal(fs.existsSync(`${data.source}-wal`), false);
      afterCheckpoint = fs.readFileSync(data.source);
    }
    return originalCopy(source, target, flags);
  });
  syncBuiltinESMExports();
  try {
    const rows = await inspectDatabaseWithoutSideEffects(data.source, data.identity, database => {
      inspections += 1;
      return database.prepare('SELECT value FROM sentinel ORDER BY rowid').all<{ value: string }>();
    });
    assert.deepEqual(rows.map(row => row.value), ['checkpointed', 'in WAL']);
    assert.equal(targets.length, 2);
    assert.equal(inspections, 1);
    assert.deepEqual(fs.readFileSync(data.source), afterCheckpoint);
    assert.deepEqual(fs.readdirSync(data.directory), ['source.sqlite3']);
    for (const target of targets) assert.equal(fs.existsSync(path.dirname(target)), false);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    data.closeWriter();
    fs.rmSync(data.directory, { recursive: true, force: true });
  }
});

test('WAL copy ENOENT does not permit retrying against a replaced database file', async (t) => {
  const data = fixture();
  const replacementPath = path.join(data.directory, 'replacement.sqlite3');
  const replacement = openConnection(replacementPath);
  replacement.exec('CREATE TABLE replacement_only(id INTEGER)');
  replacement.close();
  const originalCopy = fs.copyFileSync;
  let copies = 0;
  t.mock.method(fs, 'copyFileSync', (source: fs.PathLike, target: fs.PathLike, flags?: number) => {
    if (source === data.source) copies += 1;
    if (source === `${data.source}-wal`) {
      data.closeWriter();
      fs.renameSync(data.source, path.join(data.directory, 'displaced.sqlite3'));
      fs.renameSync(replacementPath, data.source);
    }
    return originalCopy(source, target, flags);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(inspectDatabaseWithoutSideEffects(data.source, data.identity, () => {
      assert.fail('A replaced source must not be inspected');
    }), (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT'
      && /file identity changed/.test(error.message) && error.details.retryInspection !== true);
    assert.equal(copies, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    data.closeWriter();
    fs.rmSync(data.directory, { recursive: true, force: true });
  }
});

for (const code of ['EACCES', 'ENOENT']) {
  test(`WAL copy ${code} with unchanged source propagates without retrying or touching source files`, async (t) => {
    const data = fixture();
    const originalCopy = fs.copyFileSync;
    const names = fs.readdirSync(data.directory);
    const before = names.map(name => fs.readFileSync(path.join(data.directory, name)));
    const copyFailure = Object.assign(new Error('WAL copy failed'), { code });
    let copies = 0;
    t.mock.method(fs, 'copyFileSync', (source: fs.PathLike, target: fs.PathLike, flags?: number) => {
      if (source === data.source) copies += 1;
      if (source === `${data.source}-wal`) throw copyFailure;
      return originalCopy(source, target, flags);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(inspectDatabaseWithoutSideEffects(data.source, data.identity, () => {
        assert.fail('A failed copy must not be inspected');
      }), (error: unknown) => error === copyFailure);
      assert.equal(copies, 1);
      assert.deepEqual(fs.readdirSync(data.directory), names);
      for (const [index, name] of names.entries()) {
        assert.deepEqual(fs.readFileSync(path.join(data.directory, name)), before[index]);
      }
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      data.closeWriter();
      fs.rmSync(data.directory, { recursive: true, force: true });
    }
  });
}
