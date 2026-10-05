import { appendFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { SqliteDatabase } from '../../src/db/adapter.js';
import { defineTaskVerification, recordTaskVerification } from '../../src/assurance/verification.js';
import { recordTaskEvidence, taskAssuranceReport } from '../../src/assurance/service.js';
import { repositoryStateDigest } from '../../src/assurance/snapshot.js';

const target = `${process.platform}-${process.arch}`;
const check = { id: 'fixture-check', target, expected: 'Fixture success condition', method: 'Isolated model-reported test fixture' };
function excludeDatabase(cwd: string, databasePath: string) {
  const relative = path.relative(cwd, databasePath);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) appendFileSync(path.join(cwd, '.git/info/exclude'), `\n/${relative}*\n`);
}

/** Explicit synthetic evidence for tests of other lifecycle contracts, not observed execution. */
export function verifyFixtureTask(db: SqliteDatabase, cwd: string, runId: string): void {
  excludeDatabase(cwd, db.filePath);
  const input = () => ({ cwd, runId, expectedRevision: taskAssuranceReport(db, runId).revision! });
  defineTaskVerification(db, { ...input(), requestId: 'fixture-define', reason: 'Model the successful task prerequisite', checks: [check] });
  const deliveryId = db.prepare('SELECT delivery_id FROM task_assurance WHERE run_id=?').get<{ delivery_id: string | null }>(runId)!.delivery_id;
  const evidence = recordTaskEvidence(db, { ...input(), requestId: 'fixture-evidence', deliveryId, execution: check.method,
    target, stateDigest: repositoryStateDigest(cwd), outcome: 'passed', exitCode: 0 });
  recordTaskVerification(db, { ...input(), requestId: 'fixture-record', contractVersion: 1, checkId: check.id, target,
    source: { kind: 'local', evidenceId: evidence.evidenceId } });
}

export async function verifyMcpFixtureTask(client: Client, cwd: string, runId: string, databasePath: string): Promise<void> {
  excludeDatabase(cwd, databasePath);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { cwd, runId, ...args } });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent as Record<string, any>;
  };
  let state = await call('task_memory_status', {});
  const defined = await call('task_verification_define', { requestId: 'fixture-define', expectedRevision: state.revision,
    reason: 'Model the successful task prerequisite', checks: [check] });
  state = await call('task_memory_status', { snapshot: true });
  const evidence = await call('task_execution_evidence', { requestId: 'fixture-evidence', expectedRevision: state.revision,
    deliveryId: state.deliveryId, execution: check.method, target, stateDigest: state.stateDigest, outcome: 'passed', exitCode: 0 });
  await call('task_verification_record', { requestId: 'fixture-record', expectedRevision: evidence.revision,
    contractVersion: defined.contractVersion, checkId: check.id, target, source: { kind: 'local', evidenceId: evidence.evidenceId } });
}
