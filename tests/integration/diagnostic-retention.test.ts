import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { configureDiagnosticRetention, maintainDiagnosticRetention } from '../../src/ledger/diagnostic-retention.js';
import { LedgerStore } from '../../src/ledger/store.js';
import { recordEntry } from '../../src/memory/entries.js';

test('retention is opt-in, honors terminal end boundary and preserves linked evidence and replay receipts', async () => {
 const root = mkdtempSync(path.join(tmpdir(), 'kiokuko-retention-'));
 const databasePath = path.join(root, 'memory.sqlite3');
 await initializeDatabase({ databasePath });
 const db = openConnection(databasePath);
 const at = '2026-10-11T00:00:00.000Z';
 try {
  for (const [id, status, ended] of [['old','completed','2026-09-10T23:59:59.999Z'], ['boundary','completed','2026-09-11T00:00:00.000Z'], ['active','active','2026-01-01T00:00:00.000Z'], ['intake','intake','2026-01-01T00:00:00.000Z']] as const) {
   db.prepare(`INSERT INTO ledger_runs(run_id,workspace,client_kind,protocol_version,capture_profile,coverage_json,status,metadata_json,started_at,ended_at,created_at,updated_at) VALUES(?,'p','test','1','minimal','{}',?,'{}',?,?,?,?)`).run(id,status,ended,ended,ended,ended);
   db.prepare(`INSERT INTO task_assurance(run_id,updated_at) VALUES(?,?)`).run(id,ended);
   for (const suffix of ['unlinked','linked']) {
    db.prepare('INSERT INTO task_execution_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id+'-'+suffix,id,null,root,root,'execution','state','unknown',null,'client_observed',ended);
   }
   db.prepare(`INSERT INTO task_assurance_requests VALUES(?,?,?,?)`).run(id,'retry','digest',JSON.stringify({ evidenceId: id+'-linked' }));
  }
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--import','tsx','src/bin/kiokuko.ts','diagnostics-retention','--database',databasePath,'--now',at,'--json',...args], { cwd: process.cwd(), encoding:'utf8' });
  const off = cli('--dry-run'); assert.equal(off.status,0,off.stderr); assert.equal(JSON.parse(off.stdout).retentionDays,null);
  const dry = cli('--days','30','--dry-run'); assert.equal(dry.status,0,dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout).eligibleRuns,['old']);
  assert.equal(db.prepare('SELECT retention_days FROM diagnostic_retention_settings').get<any>()!.retention_days,null);
  const apply = cli('--days','30'); assert.equal(apply.status,0,apply.stderr);
  const result = JSON.parse(apply.stdout); assert.deepEqual(result.compactedRuns,['old']); assert.equal(result.diskBytesReclaimed,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_execution_evidence WHERE evidence_id=?').get<any>('old-unlinked')!.n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_execution_evidence WHERE evidence_id=?').get<any>('old-linked')!.n,1);
  for (const id of ['boundary','active','intake']) assert.equal(db.prepare('SELECT COUNT(*) n FROM task_execution_evidence WHERE run_id=?').get<any>(id)!.n,2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM task_assurance_requests').get<any>()!.n,4);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  const again=cli(); assert.equal(again.status,0,again.stderr); assert.deepEqual(JSON.parse(again.stdout).compactedRuns,[]);
 } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

test('retention protects JSON provenance chains, rolls back failures, and runs at most daily', async () => {
 const root = mkdtempSync(path.join(tmpdir(), 'kiokuko-retention-provenance-'));
 const databasePath = path.join(root, 'memory.sqlite3');
 await initializeDatabase({ databasePath });
 const db = openConnection(databasePath);
 const now = '2026-10-11T00:00:00.000Z';
 const store = new LedgerStore(db, { now: () => '2026-09-01T00:00:00.000Z' });
 try {
  for (const id of ['provenance', 'active-reference', 'expired', 'active']) {
   store.createRun({runId:id,workspace:'p',client:{kind:'test'},protocolVersion:'1',captureProfile:'minimal',
    task:{title:'Retention fixture',query:'Verify retention',profileHints:{taskType:'review',target:'diagnostics',expected:'references survive',constraints:null}},
    coverage:{run:'declared',tool:'unavailable',command:'unavailable',file:'unavailable',approval:'unavailable'}});
   store.appendBatch(id,{events:[{eventId:id+'-event',eventType:'tool.completed',actor:'test',payload:id==='active'?{sourceEventId:'active-reference-event'}:{}}]});
   if (id !== 'active') store.updateRunStatus(id,'completed');
  }
  const memory = recordEntry(db,{workspace:'p',kind:'lesson',title:'Source provenance',body:'Retain the source chain.',tags:[],provenance:{type:'ledger',reference:'provenance-event'}});
  configureDiagnosticRetention(db,30);
  db.exec("CREATE TRIGGER retention_failure BEFORE DELETE ON ledger_events WHEN OLD.run_id='expired' BEGIN SELECT RAISE(ABORT,'forced retention failure'); END");
  assert.throws(()=>maintainDiagnosticRetention(db,{now}),/forced retention failure/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM diagnostic_run_summaries').get<any>()!.n,0);
  assert.equal(db.prepare('SELECT last_maintenance_at FROM diagnostic_retention_settings').get<any>()!.last_maintenance_at,null);
  db.exec('DROP TRIGGER retention_failure');
  const result=maintainDiagnosticRetention(db,{now});
  assert.equal(result.compactedRuns.length,3);
  assert.equal(store.verifyChain('provenance'),true);
  assert.equal(store.verifyChain('active-reference'),true);
  assert.throws(()=>store.readEvents('expired'),/expired/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM entry_revisions WHERE entry_id=?').get<any>(memory.id)!.n,1);
  assert.equal(store.readEvents('active').length,1);
  db.prepare("DELETE FROM diagnostic_run_summaries WHERE run_id='expired'").run();
  assert.deepEqual(maintainDiagnosticRetention(db,{now:'2026-10-11T12:00:00.000Z'}).compactedRuns,[]);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 } finally {db.close();rmSync(root,{recursive:true,force:true});}
});
