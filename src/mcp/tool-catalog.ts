/**
 * Kiokuko owns this tool set. Client tool registries are advisory inventory and
 * must never define the server's run-binding identity.
 */
export const KIOKUKO_MCP_TOOL_NAMES = [
  'task_prepare',
  'task_answer',
  'enno_plan_submit',
  'enno_ideal_submit',
  'enno_advice_submit',
  'enno_advice_read',
  'enno_answer',
  'enno_work_report',
  'enno_verify_prepare',
  'enno_finish',
  'enno_meditation_submit',
  'curator_check',
  'curator_globalize',
  'memory_checkpoint',
] as const;

export const KIOKUKO_MANAGED_TOOL_COUNT = KIOKUKO_MCP_TOOL_NAMES.length;
