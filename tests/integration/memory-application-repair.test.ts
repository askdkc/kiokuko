import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { recordEntry, updateCandidateEntry } from '../../src/memory/entries.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { resolveProjectWorkspace } from '../../src/memory/workspaces.js';
import { queryScopedContext } from '../../src/context/scoped-broker.js';
import { contextFeedbackSignals } from '../../src/context/feedback.js';
import { observeLessonInTransaction } from '../../src/memory/lesson-reinforcement.js';

async function fixture() {
 const root=mkdtempSync(path.join(tmpdir(),'kiokuko-relevance-')); execFileSync('git',['init','-q',root]);
 writeFileSync(path.join(root,'package.json'),JSON.stringify({dependencies:{typescript:'^5.0.0'}}));
 const databasePath=path.join(root,'db.sqlite3'); await initializeDatabase({databasePath});
 const db=openConnection(databasePath); const project=(await resolveProjectWorkspace(db,root))!;
 const query={project,task:'repair launcher',taskProfile:{taskType:'build' as const,target:'src/launcher.ts',expected:'launcher works',constraints:null}};
 return {root,db,project,query};
}

test('feedback is workspace/revision scoped; two independent irrelevant runs suppress only weak global matches',async()=>{
 const f=await fixture();
 try {
  const entry=recordEntry(f.db,{workspace:'global',kind:'lesson',title:'Launcher lesson',body:'Launcher lesson for a different task.',
   scope:buildStructuredScope({visibility:'global',retrievalScope:'global',portableReason:'Cross-project lesson.',signals:{paths:['src/strong-launcher.ts']}})});
  for(let i=0;i<2;i++) {
   const run='feedback-'+i,delivery='delivery-'+i,at='2026-09-01T00:00:00.000Z';
   f.db.prepare(`INSERT INTO ledger_runs(run_id,workspace,client_kind,protocol_version,capture_profile,coverage_json,status,metadata_json,started_at,created_at,updated_at) VALUES(?,?,'test','1','minimal','{}','completed','{}',?,?,?)`).run(run,f.project.workspace,at,at,at);
   f.db.prepare(`INSERT INTO context_deliveries(delivery_id,run_id,through_sequence,task_profile_hash,query_hash,policy_version,char_budget,char_count,truncated,created_at) VALUES(?,?,0,'p','q','policy-v1',100,1,0,?)`).run(delivery,run,at);
   f.db.prepare(`INSERT INTO context_delivery_entries(delivery_id,entry_id,entry_revision,rank,score_components_json,selection_reason_json) VALUES(?,?,1,1,'{}','[]')`).run(delivery,entry.id);
   f.db.prepare(`INSERT INTO context_feedback VALUES(?,?,?,?,'irrelevant',NULL,'test',?,?)`).run('f-'+i,delivery,entry.id,run,'k-'+i,at);
  }
  assert.equal(contextFeedbackSignals(f.db,entry.id,{workspace:f.project.workspace,entryRevision:1})[0]?.distinctRuns,2);
  assert.deepEqual(contextFeedbackSignals(f.db,entry.id,{workspace:'other-project',entryRevision:1}),[]);
  assert.deepEqual(contextFeedbackSignals(f.db,entry.id,{workspace:f.project.workspace,entryRevision:2}),[]);
  assert.ok(!(await queryScopedContext(f.db,f.query)).items.some(item=>item.entryId===entry.id));
  assert.ok((await queryScopedContext(f.db,{...f.query,taskProfile:{...f.query.taskProfile,target:'src/strong-launcher.ts'}})).items.some(item=>item.entryId===entry.id));
  const revised=updateCandidateEntry(f.db,{workspace:'global',entryId:entry.id,expectedRevision:1,kind:'lesson',title:entry.title,body:'New launcher lesson.',scope:entry.scope});
  assert.ok((await queryScopedContext(f.db,f.query)).items.some(item=>item.entryId===revised.id));
  // Old revision's irrelevant judgments cannot suppress a later strong path match either.
  const strong=updateCandidateEntry(f.db,{workspace:'global',entryId:entry.id,expectedRevision:2,kind:'lesson',title:entry.title,body:revised.body,
   scope:buildStructuredScope({visibility:'global',retrievalScope:'global',signals:{paths:['src/launcher.ts']},portableReason:'Shared launcher pattern.'})});
  assert.ok((await queryScopedContext(f.db,f.query)).items.some(item=>item.entryId===strong.id && item.selectionReasons.includes('target_path_match')));
 } finally {f.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('global task candidates honor explicit repository and applicability restrictions',async()=>{
 const f=await fixture();
 try {
  const excluded: string[]=[];
  for(const constraint of [{repositoryId:'repo_foreign'},{applicability:{languages:['python']}}]) {
   excluded.push(recordEntry(f.db,{workspace:'global',kind:'lesson',title:'Launcher repair',body:'Launcher repair exact task match.',
    scope:buildStructuredScope({visibility:'global',retrievalScope:'global',portableReason:'Reusable under restrictions.',...constraint})}).id);
  }
  const result=await queryScopedContext(f.db,f.query);
  assert.ok(result.items.every(item=>!excluded.includes(item.entryId)));
 } finally {f.db.close();rmSync(f.root,{recursive:true,force:true});}
});

test('reinforcement cannot outrank a strong current correction under a one-item budget', async () => {
 const f = await fixture();
 try {
  const repeated = recordEntry(f.db, {workspace:f.project.workspace,kind:'lesson',status:'verified',trustLevel:'system_verified',
   title:'Launcher documentation',body:'Launcher documentation lesson from a different workflow.',
   scope:buildStructuredScope({visibility:'project',retrievalScope:'project-only'}),provenance:{type:'interaction_capture',reference:'fixture'}});
  for (const id of ['observed-a','observed-b']) {
   const at='2026-09-01T00:00:00.000Z';
   f.db.prepare(`INSERT INTO ledger_runs(run_id,workspace,client_kind,protocol_version,capture_profile,coverage_json,status,metadata_json,started_at,created_at,updated_at)
    VALUES(?,?,'test','1','minimal','{}','completed','{}',?,?,?)`).run(id,f.project.workspace,at,at,at);
   observeLessonInTransaction(f.db,repeated,id,at);
  }
  const correction=recordEntry(f.db,{workspace:'global',kind:'lesson',title:'Current launcher correction',body:'Repair the current launcher entry.',
   scope:buildStructuredScope({visibility:'global',retrievalScope:'global',portableReason:'Shared launcher invariant.',signals:{paths:['src/launcher.ts']}})});
  const result=await queryScopedContext(f.db,{...f.query,limit:1,characterBudget:1000});
  assert.equal(result.items[0]?.entryId,correction.id);
 } finally { f.db.close();rmSync(f.root,{recursive:true,force:true}); }
});
