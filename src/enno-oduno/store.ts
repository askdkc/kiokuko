import { randomUUID } from 'node:crypto';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { LedgerStore } from '../ledger/store.js';
import type { JsonValue, LedgerEventInput } from '../ledger/types.js';
import { canonicalJson } from '../serialization/validate.js';
import { parseStrictJson } from '../setup/strict-json.js';
import {
  parseEnnoContract,
  parseEnnoRequestHandoff,
  parseOdunoIdeal,
  parseOdunoMeditation,
  parseWorkReportResult,
  parseWorkPlan,
} from './schemas.js';
import {
  ENNO_DEFAULT_MAX_ATTEMPTS,
  ENNO_APPLICABLE_TASK_TYPES,
  ENNO_CLIENT_KINDS,
  ENNO_STATUSES,
  type EnnoClientKind,
  type EnnoOdunoContract,
  type EnnoRequestHandoff,
  type EnnoRunSnapshot,
  type EnnoStatus,
  type OdunoIdeal,
  type OdunoMeditation,
  type StoredWorkUnit,
  type VerifierRunResult,
  type VerifierSpec,
  type WorkPlan,
  type WorkReportResult,
  type WorkUnitStatus,
} from './types.js';
import type { SkillDiscoveryMode, SkillDiscoverySummary } from '../skills/types.js';

interface ContractRow extends SqliteRow {
  run_id: string;
  workspace: string;
  orchestration_session_id: string;
  client_kind: EnnoClientKind | null;
  client_version: string | null;
  client_session_id: string | null;
  repository_root: string;
  task_type: EnnoRunSnapshot['taskType'];
  status: string;
  phase: string | null;
  revision: number;
  confirmation_state: EnnoRunSnapshot['confirmationState'];
  attempts: number;
  mutation_revision: number;
  contract_json: string;
  handoff_json: string;
  ideal_json: string | null;
  meditation_json: string | null;
  blocker: string | null;
}

interface WorkUnitRow extends SqliteRow {
  work_unit_json: string;
  status: WorkUnitStatus;
  attempt_count: number;
  result_json: string | null;
}

interface ReceiptRow extends SqliteRow {
  request_digest: string;
  state: 'started' | 'completed';
  response_json: string | null;
}

export interface EnnoIdentity {
  runId: string;
  workspace: string;
  orchestrationId: string;
}

export interface OperationIdentity {
  operation: 'ideal_submit' | 'plan_submit' | 'answer' | 'work_report' | 'finish' | 'meditation_submit';
  idempotencyKey: string;
  requestDigest: string;
}

function integrity(message: string): never {
  throw new KiokukoError('INTEGRITY_ERROR', message);
}

function parseCanonicalJson(value: string, message: string): unknown {
  let parsed: unknown;
  try {
    parsed = parseStrictJson(
      value,
      { allowTrailingComma: false, disallowComments: true, allowEmptyContent: false },
      message,
    );
  } catch {
    return integrity(message);
  }
  if (canonicalJson(parsed) !== value) return integrity(message);
  return parsed;
}

function contractRow(database: SqliteDatabase, runId: string): ContractRow | undefined {
  return database.prepare('SELECT * FROM enno_contracts WHERE run_id = ?').get<ContractRow>(runId);
}

function validateContractRow(row: ContractRow): void {
  if (!ENNO_STATUSES.includes(row.status as EnnoStatus)
    || !ENNO_APPLICABLE_TASK_TYPES.includes(row.task_type)
    || !Number.isSafeInteger(row.revision) || row.revision < 1
    || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts > 20
    || !Number.isSafeInteger(row.mutation_revision) || row.mutation_revision < 0) {
    integrity('Stored Enno run state is invalid');
  }
}

function exposedStatus(row: Pick<ContractRow, 'status' | 'phase'>): EnnoStatus {
  if (row.phase === null) return row.status as EnnoStatus;
  if (row.phase === 'oduno_ideal' && row.status === 'zenki_planning') return row.phase;
  if (row.phase === 'oduno_meditation' && row.status === 'enno_verifying') return row.phase;
  return integrity('Stored Oduno phase is inconsistent');
}

function persistedState(status: EnnoStatus): { status: string; phase: string | null } {
  if (status === 'oduno_ideal') return { status: 'zenki_planning', phase: status };
  if (status === 'oduno_meditation') return { status: 'enno_verifying', phase: status };
  return { status, phase: null };
}

function workUnits(database: SqliteDatabase, runId: string, revision: number): StoredWorkUnit[] {
  const rows = database.prepare(`
    SELECT work_unit_json, status, attempt_count, result_json
    FROM enno_work_units
    WHERE run_id = ? AND contract_revision = ?
    ORDER BY order_index
  `).all<WorkUnitRow>(runId, revision);
  if (rows.length === 0) return [];
  const parsed = parseWorkPlan({
    objective: 'stored units',
    units: rows.map((row) => parseCanonicalJson(row.work_unit_json, 'Stored Enno WorkUnit is invalid')),
  });
  return rows.map((row, index) => ({
    workUnit: parsed.units[index]!,
    status: row.status,
    attemptCount: row.attempt_count,
    result: row.result_json === null
      ? null
      : parseWorkReportResult(parseCanonicalJson(row.result_json, 'Stored Enno work result is invalid')),
  }));
}

function assertLedgerIdentity(database: SqliteDatabase, identity: EnnoIdentity, repositoryRoot?: string): void {
  const run = new LedgerStore(database).readRun(identity.runId, identity.workspace);
  if (run === undefined) throw new KiokukoError('NOT_FOUND', 'Enno run was not found');
  const intake = database.prepare('SELECT session_id AS sessionId FROM run_intakes WHERE run_id = ?')
    .get<{ sessionId: string }>(identity.runId);
  if (intake?.sessionId !== identity.orchestrationId) {
    throw new KiokukoError('CONFLICT', 'Enno orchestration session does not own this run');
  }
  if (repositoryRoot !== undefined && contractRow(database, identity.runId)?.repository_root !== repositoryRoot) {
    throw new KiokukoError('CONFLICT', 'Enno repository binding changed');
  }
}

export function readEnnoSnapshot(database: SqliteDatabase, identity: EnnoIdentity): EnnoRunSnapshot {
  assertLedgerIdentity(database, identity);
  const row = contractRow(database, identity.runId);
  if (row === undefined) throw new KiokukoError('NOT_FOUND', 'Enno contract was not found');
  validateContractRow(row);
  if (row.workspace !== identity.workspace || row.orchestration_session_id !== identity.orchestrationId) {
    throw new KiokukoError('CONFLICT', 'Enno run identity changed');
  }
  if ((row.client_kind !== null && !ENNO_CLIENT_KINDS.includes(row.client_kind))
    || ((row.client_version !== null || row.client_session_id !== null) && row.client_kind === null)) {
    integrity('Stored Enno client binding is invalid');
  }
  const contract = parseEnnoContract(parseCanonicalJson(row.contract_json, 'Stored Enno contract is invalid'));
  const handoff = parseEnnoRequestHandoff(parseCanonicalJson(row.handoff_json, 'Stored Enno request handoff is invalid'));
  const ideal = row.ideal_json === null
    ? null
    : parseOdunoIdeal(parseCanonicalJson(row.ideal_json, 'Stored Oduno ideal is invalid'));
  const meditation = row.meditation_json === null
    ? null
    : parseOdunoMeditation(parseCanonicalJson(row.meditation_json, 'Stored Oduno meditation is invalid'));
  const status = exposedStatus(row);
  if (contract.revision !== row.revision) integrity('Stored Enno contract revision is inconsistent');
  if (handoff.taskType !== row.task_type) integrity('Stored Enno request handoff is inconsistent');
  if (status === 'oduno_ideal' && ideal !== null) integrity('Stored Oduno ideal phase is inconsistent');
  if (status === 'oduno_meditation' && (ideal === null || meditation !== null)) {
    integrity('Stored Oduno meditation phase is inconsistent');
  }
  if (meditation !== null && status !== 'completed') integrity('Stored Oduno meditation result is inconsistent');
  return {
    runId: row.run_id,
    workspace: row.workspace,
    orchestrationId: row.orchestration_session_id,
    clientKind: row.client_kind,
    clientVersion: row.client_version,
    clientSessionId: row.client_session_id,
    repositoryRoot: row.repository_root,
    taskType: row.task_type,
    status,
    revision: row.revision,
    confirmationState: row.confirmation_state,
    attempts: row.attempts,
    mutationRevision: row.mutation_revision,
    ideal,
    meditation,
    contract,
    handoff,
    workUnits: workUnits(database, identity.runId, row.revision),
    blocker: row.blocker,
  };
}

function emptyDiscovery(mode: SkillDiscoveryMode): SkillDiscoverySummary {
  return {
    attempted: false,
    mode,
    requirements: [],
    queries: [],
    cacheHits: 0,
    candidates: 0,
    selected: [],
    failures: [],
  };
}

export function createEnnoDraft(database: SqliteDatabase, input: EnnoIdentity & {
  repositoryRoot: string;
  taskType: EnnoRunSnapshot['taskType'];
  taskTarget: string | null;
  taskExpected: string | null;
  handoff: EnnoRequestHandoff;
  skillDiscovery: SkillDiscoverySummary;
  initialClientKind?: string;
  initialClientVersion?: string;
  initialClientSessionId?: string;
}): EnnoRunSnapshot {
  return withImmediateTransaction(database, () => {
    assertLedgerIdentity(database, input);
    const existing = contractRow(database, input.runId);
    if (existing !== undefined) return readEnnoSnapshot(database, input);
    const contract: EnnoOdunoContract = {
      revision: 1,
      scope: input.taskTarget === null ? [] : [input.taskTarget],
      exclusions: [],
      acceptanceCriteria: input.taskExpected === null ? [] : [{ id: 'task-expected', description: input.taskExpected }],
      workPlan: { objective: input.taskTarget ?? 'Plan the requested task', units: [] },
      skillSet: {
        entries: [],
        intakeDiscovery: input.skillDiscovery,
        zenkiDiscovery: emptyDiscovery(input.skillDiscovery.mode),
      },
      finalVerifiers: [],
      maxAttempts: ENNO_DEFAULT_MAX_ATTEMPTS,
      provenance: {
        scope: 'inferred',
        exclusions: 'inferred',
        acceptanceCriteria: 'inferred',
        workPlan: 'inferred',
        skillSet: 'inferred',
        finalVerifiers: 'inferred',
        maxAttempts: 'inferred',
      },
    };
    const recognizedClientKind = typeof input.initialClientKind === 'string'
      && ENNO_CLIENT_KINDS.includes(input.initialClientKind as EnnoClientKind)
      ? input.initialClientKind as EnnoClientKind
      : null;
    const clientVersion = recognizedClientKind === null ? null : input.initialClientVersion ?? null;
    const clientSessionId = recognizedClientKind === null ? null : input.initialClientSessionId ?? null;
    const now = new Date().toISOString();
    database.prepare(`
      INSERT INTO enno_contracts (
        run_id, workspace, orchestration_session_id, client_kind, client_version, client_session_id,
        repository_root, task_type, status, revision,
        confirmation_state, attempts, mutation_revision, contract_json, handoff_json,
        intake_discovery_json, plan_digest, blocker, created_at, updated_at
        , phase, ideal_json, meditation_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'zenki_planning', 1, 'not_required', 0, 0, ?, ?, ?, NULL, NULL, ?, ?, 'oduno_ideal', NULL, NULL)
    `).run(
      input.runId,
      input.workspace,
      input.orchestrationId,
      recognizedClientKind,
      clientVersion,
      clientSessionId,
      input.repositoryRoot,
      input.taskType,
      canonicalJson(contract),
      canonicalJson(input.handoff),
      canonicalJson(input.skillDiscovery),
      now,
      now,
    );
    appendEnnoEventInTransaction(database, input.runId, 'enno.started', 'enno-oduno', 'started', {
      contractRevision: 1,
      harnessKind: recognizedClientKind,
      clientBinding: clientSessionId === null ? 'pending' : 'bound',
    });
    return readEnnoSnapshot(database, input);
  });
}

export function appendEnnoEventInTransaction(
  database: SqliteDatabase,
  runId: string,
  eventType: LedgerEventInput['eventType'],
  actor: 'enno-oduno' | 'zenki' | 'goki',
  outcome: string,
  payload: JsonValue,
): void {
  new LedgerStore(database).appendBatchInTransaction(runId, { events: [{
    eventId: randomUUID(),
    eventType,
    actor,
    outcome,
    payload,
  }] });
}

export function updateContractInTransaction(database: SqliteDatabase, snapshot: EnnoRunSnapshot, input: {
  contract: EnnoOdunoContract;
  status: EnnoStatus;
  confirmationState: EnnoRunSnapshot['confirmationState'];
  blocker?: string | null;
  attempts?: number;
  mutationRevision?: number;
  planDigest?: string | null;
  ideal?: OdunoIdeal | null;
  meditation?: OdunoMeditation | null;
}): void {
  const nextState = persistedState(input.status);
  const currentState = persistedState(snapshot.status);
  const updated = database.prepare(`
    UPDATE enno_contracts
    SET status = ?, phase = ?, revision = ?, confirmation_state = ?, attempts = ?, mutation_revision = ?,
        contract_json = ?, ideal_json = ?, meditation_json = ?, plan_digest = ?, blocker = ?, updated_at = ?
    WHERE run_id = ? AND workspace = ? AND orchestration_session_id = ? AND revision = ?
      AND status = ? AND phase IS ?
    RETURNING run_id AS runId
  `).get<{ runId: string }>(
    nextState.status,
    nextState.phase,
    input.contract.revision,
    input.confirmationState,
    input.attempts ?? snapshot.attempts,
    input.mutationRevision ?? snapshot.mutationRevision,
    canonicalJson(input.contract),
    input.ideal === undefined
      ? snapshot.ideal === null ? null : canonicalJson(snapshot.ideal)
      : input.ideal === null ? null : canonicalJson(input.ideal),
    input.meditation === undefined
      ? snapshot.meditation === null ? null : canonicalJson(snapshot.meditation)
      : input.meditation === null ? null : canonicalJson(input.meditation),
    input.planDigest ?? null,
    input.blocker ?? null,
    new Date().toISOString(),
    snapshot.runId,
    snapshot.workspace,
    snapshot.orchestrationId,
    snapshot.revision,
    currentState.status,
    currentState.phase,
  );
  if (updated?.runId !== snapshot.runId) throw new KiokukoError('CONFLICT', 'Enno state changed concurrently');
}

export function replaceWorkUnitsInTransaction(database: SqliteDatabase, runId: string, revision: number, workPlan: WorkPlan): void {
  database.prepare('DELETE FROM enno_work_units WHERE run_id = ? AND contract_revision = ?').run(runId, revision);
  const statement = database.prepare(`
    INSERT INTO enno_work_units (
      run_id, work_unit_id, contract_revision, order_index, work_unit_json,
      status, attempt_count, result_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)
  `);
  const now = new Date().toISOString();
  workPlan.units.forEach((unit, index) => {
    statement.run(runId, unit.id, revision, index, canonicalJson(unit), now, now);
  });
}

export function setWorkUnitStatusInTransaction(database: SqliteDatabase, input: {
  runId: string;
  contractRevision: number;
  workUnitId: string;
  from: WorkUnitStatus | readonly WorkUnitStatus[];
  to: WorkUnitStatus;
  attemptCount?: number;
  result?: WorkReportResult | null;
}): void {
  const from = Array.isArray(input.from) ? input.from : [input.from];
  const placeholders = from.map(() => '?').join(', ');
  const updated = database.prepare(`
    UPDATE enno_work_units
    SET status = ?,
        attempt_count = COALESCE(?, attempt_count),
        result_json = ?,
        updated_at = ?
    WHERE run_id = ? AND contract_revision = ? AND work_unit_id = ? AND status IN (${placeholders})
    RETURNING work_unit_id AS workUnitId
  `).get<{ workUnitId: string }>(
    input.to,
    input.attemptCount ?? null,
    input.result === undefined || input.result === null ? null : canonicalJson(input.result),
    new Date().toISOString(),
    input.runId,
    input.contractRevision,
    input.workUnitId,
    ...from,
  );
  if (updated?.workUnitId !== input.workUnitId) throw new KiokukoError('CONFLICT', 'Enno WorkUnit changed concurrently');
}

export function startVerifierRunsInTransaction(database: SqliteDatabase, input: {
  runId: string;
  workUnitId: string | null;
  revision: number;
  mutationRevision: number;
  verifiers: readonly VerifierSpec[];
}): string[] {
  const statement = database.prepare(`
    INSERT INTO enno_verifier_runs (
      verifier_run_id, run_id, work_unit_id, contract_revision, mutation_revision,
      verifier_id, verifier_json, status, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'started', ?)
  `);
  const now = new Date().toISOString();
  return input.verifiers.map((verifier) => {
    const verifierRunId = randomUUID();
    statement.run(
      verifierRunId,
      input.runId,
      input.workUnitId,
      input.revision,
      input.mutationRevision,
      verifier.id,
      canonicalJson(verifier),
      now,
    );
    return verifierRunId;
  });
}

export function finishVerifierRunsInTransaction(
  database: SqliteDatabase,
  verifierRunIds: readonly string[],
  results: readonly VerifierRunResult[],
): void {
  if (verifierRunIds.length !== results.length) integrity('Enno verifier result count is inconsistent');
  const finishedAt = new Date().toISOString();
  results.forEach((result, index) => {
    const verifierRunId = verifierRunIds[index];
    if (verifierRunId === undefined) integrity('Enno verifier result count is inconsistent');
    const updated = database.prepare(`
      UPDATE enno_verifier_runs
      SET status = ?, exit_code = ?, signal = ?, duration_ms = ?,
          stdout_preview = ?, stderr_preview = ?, stdout_digest = ?, stderr_digest = ?, finished_at = ?
      WHERE verifier_run_id = ? AND status = 'started'
      RETURNING verifier_run_id AS verifierRunId
    `).get<{ verifierRunId: string }>(
      result.status,
      result.exitCode,
      result.signal,
      result.durationMs,
      result.stdoutPreview,
      result.stderrPreview,
      result.stdoutDigest,
      result.stderrDigest,
      finishedAt,
      verifierRunId,
    );
    if (updated?.verifierRunId !== verifierRunId) throw new KiokukoError('CONFLICT', 'Enno verifier state changed concurrently');
  });
}

export function readOperationReceipt<T>(database: SqliteDatabase, runId: string, operation: OperationIdentity): T | undefined {
  const row = database.prepare(`
    SELECT request_digest, state, response_json
    FROM enno_operation_receipts
    WHERE run_id = ? AND operation = ? AND idempotency_key = ?
  `).get<ReceiptRow>(runId, operation.operation, operation.idempotencyKey);
  if (row === undefined) return undefined;
  if (row.request_digest !== operation.requestDigest) {
    throw new KiokukoError('CONFLICT', 'Enno idempotency key was reused with different input');
  }
  if (row.state === 'started') throw new KiokukoError('CONFLICT', 'Enno operation is already in progress');
  if (row.response_json === null) integrity('Stored Enno operation receipt is invalid');
  return parseCanonicalJson(row.response_json, 'Stored Enno operation receipt is invalid') as T;
}

export function startOperationInTransaction(database: SqliteDatabase, runId: string, operation: OperationIdentity): void {
  const replay = readOperationReceipt<unknown>(database, runId, operation);
  if (replay !== undefined) throw new KiokukoError('CONFLICT', 'Completed Enno operation must be replayed before mutation');
  const active = database.prepare(`
    SELECT operation FROM enno_operation_receipts
    WHERE run_id = ? AND state = 'started'
    LIMIT 1
  `).get<{ operation: string }>(runId);
  if (active !== undefined) throw new KiokukoError('CONFLICT', 'Another Enno operation is already in progress');
  database.prepare(`
    INSERT INTO enno_operation_receipts (
      run_id, operation, idempotency_key, request_digest, state, response_json, created_at, finished_at
    ) VALUES (?, ?, ?, ?, 'started', NULL, ?, NULL)
  `).run(runId, operation.operation, operation.idempotencyKey, operation.requestDigest, new Date().toISOString());
}

export function completeOperationInTransaction(
  database: SqliteDatabase,
  runId: string,
  operation: OperationIdentity,
  response: unknown,
): void {
  const serialized = canonicalJson(response);
  const updated = database.prepare(`
    UPDATE enno_operation_receipts
    SET state = 'completed', response_json = ?, finished_at = ?
    WHERE run_id = ? AND operation = ? AND idempotency_key = ?
      AND request_digest = ? AND state = 'started'
    RETURNING run_id AS runId
  `).get<{ runId: string }>(
    serialized,
    new Date().toISOString(),
    runId,
    operation.operation,
    operation.idempotencyKey,
    operation.requestDigest,
  );
  if (updated?.runId !== runId) throw new KiokukoError('CONFLICT', 'Enno operation receipt changed concurrently');
}

export function terminalizeLedgerRunInTransaction(database: SqliteDatabase, runId: string, status: 'completed' | 'failed' | 'cancelled'): void {
  new LedgerStore(database).updateRunStatusInTransaction(runId, status);
}
