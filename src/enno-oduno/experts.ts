import { KiokukoError } from '../errors.js';
import {
  STANDARD_FUNCTION_EXPERT_IDS,
  STANDARD_UI_EXPERT_IDS,
} from '../setup/standard-skills.js';
import type { WorkPlan } from './types.js';

const functionExpertIds = new Set<string>(STANDARD_FUNCTION_EXPERT_IDS);
const uiExpertIds = new Set<string>(STANDARD_UI_EXPERT_IDS);

function hasExpert(unit: WorkPlan['units'][number], expertIds: ReadonlySet<string>): boolean {
  return unit.expertRefs.some((reference) => expertIds.has(reference.id));
}

export function assertWorkPlanExpertCoverage(
  workPlan: WorkPlan,
  requirements: { includesCodeChanges: boolean; includesUiWork: boolean },
): void {
  for (const unit of workPlan.units) {
    if (requirements.includesCodeChanges && !hasExpert(unit, functionExpertIds)) {
      throw new KiokukoError(
        'VALIDATION_ERROR',
        `WorkUnit ${unit.id} must select a code expert fragment`,
      );
    }
    if (requirements.includesUiWork && !hasExpert(unit, uiExpertIds)) {
      throw new KiokukoError(
        'VALIDATION_ERROR',
        `WorkUnit ${unit.id} must select a UI expert fragment`,
      );
    }
  }
}
