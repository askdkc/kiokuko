import path from 'node:path';
import * as z from 'zod/v4';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { canonicalDirectory } from '../repository/detect-root.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { directiveForRun } from './directives.js';
import {
  appendEnnoEventInTransaction,
  readEnnoSnapshot,
  terminalizeLedgerRunInTransaction,
  updateContractInTransaction,
} from './store.js';
import {
  ENNO_CLIENT_KINDS,
  type EnnoClientKind,
  type EnnoOdunoState,
  type RoleDirective,
} from './types.js';

export const ENNO_ADAPTER_WARNING = 'Kiokuko Enno-Oduno adapter unavailable; allowing the client to stop.';
export const ENNO_CLIENTS = ENNO_CLIENT_KINDS;
export type EnnoClient = EnnoClientKind;
const CLAUDE_SAFE_STOP_BLOCK_LIMIT = 7;

const hookInputSchema = z.object({
  session_id: z.string().min(1).max(256).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  cwd: z.string().min(1).max(4_096),
  stop_hook_active: z.boolean().optional(),
}).passthrough();

interface CandidateRow extends SqliteRow {
  runId: string;
  workspace: string;
  orchestrationId: string;
  clientKind: EnnoClient | null;
  clientSessionId: string | null;
  repositoryRoot: string;
  status: EnnoOdunoState['status'];
}

export interface AdapterDecision {
  continue: boolean;
  runId: string | null;
  status: EnnoOdunoState['status'] | null;
  directive: RoleDirective | null;
  reason: string | null;
  warning: string | null;
}

function isUnder(root: string, cwd: string): boolean {
  const relative = path.relative(root, cwd);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function exactSessionCandidates(
  database: SqliteDatabase,
  client: EnnoClient,
  sessionId: string,
  cwd: string,
): CandidateRow[] {
  return database.prepare(`
    SELECT ec.run_id AS runId, ec.workspace, ec.orchestration_session_id AS orchestrationId,
           ec.client_kind AS clientKind, ec.client_session_id AS clientSessionId,
           ec.repository_root AS repositoryRoot, ec.status
    FROM enno_contracts AS ec
    WHERE ec.client_session_id = ?
      AND ec.client_kind = ?
      AND ec.status IN ('zenki_planning', 'goki_executing', 'enno_verifying')
  `).all<CandidateRow>(sessionId, client)
    .filter((candidate) => isUnder(candidate.repositoryRoot, cwd));
}

function pendingSessionCandidates(database: SqliteDatabase, client: EnnoClient, cwd: string): CandidateRow[] {
  return database.prepare(`
    SELECT ec.run_id AS runId, ec.workspace, ec.orchestration_session_id AS orchestrationId,
           ec.client_kind AS clientKind, ec.client_session_id AS clientSessionId,
           ec.repository_root AS repositoryRoot, ec.status
    FROM enno_contracts AS ec
    WHERE ec.client_session_id IS NULL
      AND (ec.client_kind IS NULL OR ec.client_kind = ?)
      AND ec.status IN ('zenki_planning', 'goki_executing', 'enno_verifying')
  `).all<CandidateRow>(client)
    .filter((candidate) => isUnder(candidate.repositoryRoot, cwd));
}

type CandidateResolution =
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'resolved'; candidate: CandidateRow };

function bindPendingCandidateInTransaction(
  database: SqliteDatabase,
  candidate: CandidateRow,
  client: EnnoClient,
  sessionId: string,
): CandidateRow {
  const updated = database.prepare(`
    UPDATE enno_contracts
    SET client_kind = ?, client_session_id = ?, updated_at = ?
    WHERE run_id = ?
      AND orchestration_session_id = ?
      AND client_session_id IS NULL
      AND (client_kind IS NULL OR client_kind = ?)
    RETURNING run_id AS runId
  `).get<{ runId: string }>(
    client,
    sessionId,
    new Date().toISOString(),
    candidate.runId,
    candidate.orchestrationId,
    client,
  );
  if (updated?.runId !== candidate.runId) {
    throw new KiokukoError('CONFLICT', 'Enno client binding changed concurrently');
  }
  appendEnnoEventInTransaction(database, candidate.runId, 'enno.client_bound', 'enno-oduno', 'bound', {
    clientKind: client,
  });
  return { ...candidate, clientKind: client, clientSessionId: sessionId };
}

function resolveCandidateInTransaction(
  database: SqliteDatabase,
  client: EnnoClient,
  sessionId: string,
  cwd: string,
): CandidateResolution {
  const exact = exactSessionCandidates(database, client, sessionId, cwd);
  if (exact.length > 1) return { kind: 'ambiguous' };
  if (exact[0] !== undefined) return { kind: 'resolved', candidate: exact[0] };
  const pending = pendingSessionCandidates(database, client, cwd);
  if (pending.length === 0) return { kind: 'none' };
  if (pending.length > 1) return { kind: 'ambiguous' };
  return { kind: 'resolved', candidate: bindPendingCandidateInTransaction(database, pending[0]!, client, sessionId) };
}

function continuationPrompt(directive: RoleDirective): string {
  return `Enno-Oduno requires continuation. Follow this run-bound role directive exactly and do not claim completion early:\n${JSON.stringify(directive)}`;
}

function claimContinuation(
  database: SqliteDatabase,
  client: EnnoClient,
  snapshot: ReturnType<typeof readEnnoSnapshot>,
  directiveDigest: string,
): boolean {
  if (snapshot.clientSessionId === null || snapshot.clientKind !== client) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Enno continuation requires an exact client binding');
  }
  const existing = database.prepare(`
    SELECT contract_revision AS contractRevision, mutation_revision AS mutationRevision,
           attempts, directive_digest AS directiveDigest, continuation_count AS continuationCount,
           total_count AS totalCount
    FROM enno_client_continuations
    WHERE run_id = ? AND client_kind = ? AND source_session_id = ?
  `).get<{
    contractRevision: number;
    mutationRevision: number;
    attempts: number;
    directiveDigest: string;
    continuationCount: number;
    totalCount: number;
  }>(
    snapshot.runId,
    client,
    snapshot.clientSessionId,
  );
  const unchanged = existing?.contractRevision === snapshot.revision
    && existing.mutationRevision === snapshot.mutationRevision
    && existing.attempts === snapshot.attempts
    && existing.directiveDigest === directiveDigest;
  const count = unchanged ? existing.continuationCount : 0;
  const remaining = Math.max(0, snapshot.contract.maxAttempts - snapshot.attempts);
  const totalCount = existing?.totalCount ?? 0;
  const totalLimit = client === 'claude'
    ? Math.min(remaining, CLAUDE_SAFE_STOP_BLOCK_LIMIT)
    : snapshot.contract.maxAttempts;
  if (count >= remaining || totalCount >= totalLimit) return false;
  database.prepare(`
    INSERT INTO enno_client_continuations (
      run_id, client_kind, source_session_id, contract_revision, mutation_revision,
      attempts, directive_digest, continuation_count, total_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
    ON CONFLICT(run_id, client_kind, source_session_id) DO UPDATE SET
      contract_revision = excluded.contract_revision,
      mutation_revision = excluded.mutation_revision,
      attempts = excluded.attempts,
      directive_digest = excluded.directive_digest,
      continuation_count = CASE
        WHEN enno_client_continuations.contract_revision = excluded.contract_revision
         AND enno_client_continuations.mutation_revision = excluded.mutation_revision
         AND enno_client_continuations.attempts = excluded.attempts
         AND enno_client_continuations.directive_digest = excluded.directive_digest
        THEN enno_client_continuations.continuation_count + 1
        ELSE 1
      END,
      total_count = enno_client_continuations.total_count + 1,
      updated_at = excluded.updated_at
  `).run(
    snapshot.runId,
    client,
    snapshot.clientSessionId,
    snapshot.revision,
    snapshot.mutationRevision,
    snapshot.attempts,
    directiveDigest,
    new Date().toISOString(),
  );
  return true;
}

function blockForContinuationLimit(database: SqliteDatabase, snapshot: ReturnType<typeof readEnnoSnapshot>): void {
  updateContractInTransaction(database, snapshot, {
    contract: snapshot.contract,
    status: 'blocked',
    confirmationState: snapshot.confirmationState,
    blocker: 'Enno-Oduno continuation limit reached',
  });
  appendEnnoEventInTransaction(database, snapshot.runId, 'enno.blocked', 'enno-oduno', 'blocked', {
    reason: 'continuation_limit',
    contractRevision: snapshot.revision,
    attempts: snapshot.attempts,
  });
  terminalizeLedgerRunInTransaction(database, snapshot.runId, 'failed');
}

export function decideAdapterContinuation(database: SqliteDatabase, client: EnnoClient, rawInput: unknown): AdapterDecision {
  const parsed = hookInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new KiokukoError('VALIDATION_ERROR', 'Enno client hook input is invalid');
  const sessionId = parsed.data.session_id ?? parsed.data.sessionId;
  if (sessionId === undefined) throw new KiokukoError('VALIDATION_ERROR', 'Enno client session ID is required');
  const cwd = canonicalDirectory(parsed.data.cwd);
  const continuation = withImmediateTransaction(database, () => {
    const resolution = resolveCandidateInTransaction(database, client, sessionId, cwd);
    if (resolution.kind !== 'resolved') return resolution;
    const candidate = resolution.candidate;
    const snapshot = readEnnoSnapshot(database, {
      runId: candidate.runId,
      workspace: candidate.workspace,
      orchestrationId: candidate.orchestrationId,
    });
    if (snapshot.clientKind !== client || snapshot.clientSessionId !== sessionId) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Enno client binding is inconsistent');
    }
    const directive = directiveForRun(snapshot);
    if (directive === null) throw new KiokukoError('INTEGRITY_ERROR', 'Enno active run has no role directive');
    const claimed = claimContinuation(database, client, snapshot, canonicalContentHash(directive));
    if (!claimed) blockForContinuationLimit(database, snapshot);
    return { kind: 'continuation', snapshot, directive, claimed } as const;
  });
  if (continuation.kind === 'none') {
    return { continue: false, runId: null, status: null, directive: null, reason: null, warning: null };
  }
  if (continuation.kind === 'ambiguous') {
    return {
      continue: false,
      runId: null,
      status: null,
      directive: null,
      reason: null,
      warning: 'Multiple Enno-Oduno runs match this client and repository; returning control without guessing.',
    };
  }
  const { snapshot } = continuation;
  if (!continuation.claimed) {
    return {
      continue: false,
      runId: snapshot.runId,
      status: 'blocked',
      directive: null,
      reason: null,
      warning: 'Enno-Oduno continuation limit reached; returning control to the user.',
    };
  }
  return {
    continue: true,
    runId: snapshot.runId,
    status: snapshot.status,
    directive: continuation.directive,
    reason: continuationPrompt(continuation.directive),
    warning: null,
  };
}

export function renderStopHookDecision(decision: AdapterDecision): object {
  return decision.continue && decision.reason !== null
    ? { decision: 'block', reason: decision.reason }
    : decision.warning === null ? {} : { systemMessage: decision.warning };
}

export function renderOpenCodeDecision(decision: AdapterDecision): object {
  return decision;
}

export function failOpenAdapterOutput(client: EnnoClient): object {
  return client === 'opencode'
    ? { continue: false, runId: null, status: null, directive: null, reason: null, warning: ENNO_ADAPTER_WARNING }
    : { systemMessage: ENNO_ADAPTER_WARNING };
}
