export const CHECKPOINT_RUN_NOT_ACTIVE_CODE = 'CHECKPOINT_RUN_NOT_ACTIVE' as const;

export const CHECKPOINT_INTAKE_ERROR_MESSAGE =
  'Checkpoint is blocked while the run awaits intake answers. Complete task_answer before retrying.';

export const CHECKPOINT_TERMINAL_ERROR_MESSAGE =
  'Checkpoint is blocked because the run is terminal.';

export const CHECKPOINT_CONTRACT_FRAGMENT =
  'When `runId` is supplied, the run must be active. Do not call `memory_checkpoint` while `task_prepare` or `task_answer` reports `needs_answer` or `nextAction=answer_from_evidence_or_ask_user`; complete the required `task_answer` loop first. A successful terminal checkpoint is allowed at most once per logical request. A rejected precondition does not count as that successful checkpoint and may be retried only after the indicated run-state change.';

export const CHECKPOINT_TOOL_DESCRIPTION =
  `Store one final batch of durable facts, decisions, lessons, preferences, or references as untrusted candidate memory. ${CHECKPOINT_CONTRACT_FRAGMENT} After a successful terminal checkpoint, call no more tools and return the final response. Defaults to the current project. Use Curator for learned knowledge that may become global; choose direct global scope only when the user explicitly requested it. Secret-like content is rejected.`;

export const CHECKPOINT_RUN_ID_DESCRIPTION =
  'Exact run.runId returned by task_prepare. The run must have reached active; intake/needs_answer runs must complete task_answer first.';
