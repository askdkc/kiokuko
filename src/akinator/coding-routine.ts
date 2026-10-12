import { inspectTask } from '../assurance/inspect.js';
import { KiokukoError } from '../errors.js';
import { STANDARD_CODING_ROUTINE_SKILL_NAME } from '../setup/standard-skills.js';
import { requiresCodingRoutine } from './capabilities.js';
import type { TaskProfile } from './types.js';

/** Deliver the package-owned core independently of local Skill discovery and memory budgets. */
export function loadRequiredCodingRoutine(cwd: string, task: string, profile: TaskProfile) {
  if (!requiresCodingRoutine(task, profile)) return undefined;
  const loaded = inspectTask({ cwd, operation: 'skill', path: STANDARD_CODING_ROUTINE_SKILL_NAME });
  if (!('contentHash' in loaded)) throw new KiokukoError('INTEGRITY_ERROR', 'Bundled coding routine metadata is unavailable');
  return {
    name: STANDARD_CODING_ROUTINE_SKILL_NAME,
    required: true as const,
    applyWhen: 'After intake and memory review permit progress, apply this complete core before coding plans, code changes or verification. Read only applicable linked references through task_inspect.',
    ...loaded,
  };
}
