import { KiokukoError } from '../errors.js';

const conditions = {
  assurance_revision_changed: ['The assurance revision changed.', true],
  request_id_reused: ['Assurance request identity was reused with different content.', false],
  repository_mismatch: ['The repository does not match the task run.', false],
  capability_catalog_mismatch: ['Capability catalog differs from the catalog bound when the run was opened.', false],
  context_budget_mismatch: ['The context budget differs from the prepared run.', false],
  run_not_active: ['Task assurance requires an active run.', false],
  assurance_unavailable: ['This historical run has no assurance contract.', false],
  required_capability_unavailable: ['A required capability is unavailable.', false],
  retrieval_state_changed: ['The retrieval state changed before persistence.', true],
  verification_contract_changed: ['The verification contract changed.', false],
  verification_target_mismatch: ['The verification target or evidence does not match.', false],
  task_verification_incomplete: ['Required task verification is incomplete.', false],
} as const;

export type TaskConflictReason = keyof typeof conditions;

/** Fixed public diagnostics: never include exception text, paths, catalogs or memory bodies. */
export class TaskStateConflict extends KiokukoError {
  constructor(readonly reason: TaskConflictReason, revisions?: { expectedRevision: number; currentRevision: number }) {
    const [message, recoverable] = conditions[reason];
    super('CONFLICT', message, {
      reason, retryable: false, recoverable, maxRecoveryAttempts: recoverable ? 1 : 0,
      nextAction: recoverable ? 'read_task_memory_status'
        : reason === 'task_verification_incomplete' ? 'complete_required_verification'
          : reason === 'request_id_reused' ? 'use_new_request_id_for_new_operation' : 'stop_and_report',
      ...(revisions === undefined ? {} : revisions),
    });
  }
}

export const TASK_RECOVERY_INSTRUCTIONS = 'Do not repeat an unchanged failed operation. A typed recoverable task-state conflict permits at most one recovery: read task_memory_status, preserve the run and bound capability catalog, then submit a new requestId with the current revision. Review any new delivery before continuing. retryable=false forbids unchanged replay; it does not forbid this new operation. A second conflict, binding mismatch, terminal run or unknown failure is not automatically recoverable. Report the concrete blocker and unfinished work. A host policy denial always ends the turn; never recover or retry after that denial.';
