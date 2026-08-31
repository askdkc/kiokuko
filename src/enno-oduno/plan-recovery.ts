import { KiokukoError } from '../errors.js';
import { findSecretInValue } from '../memory/secrets.js';
import { canonicalJson } from '../serialization/validate.js';
import {
  normalizeSkillRequirementSet,
  skillRequirementDifference,
  skillRequirementDifferenceIsEmpty,
  zenkiRequirementsPreserveOduno,
} from './skills.js';
import type { SkillRequirement, SkillRequirementDifference } from './types.js';

export const PLAN_START_RECOVERY_CODE = 'PLAN_START_RECOVERY_REQUIRED' as const;
export const PLAN_START_RECOVERY_DETAIL_KEY = 'planStartRecoveryReason' as const;
export const PLAN_START_RECOVERY_REASONS = [
  'environment_information_missing',
  'environment_changed',
  'previous_attempt_ended',
  'role_skill_set_conflict',
] as const;

export type PlanStartRecoveryReason = (typeof PLAN_START_RECOVERY_REASONS)[number];
export const PLAN_START_RECOVERY_BLOCKER_PREFIX = 'plan_start_recovery:';

export function planStartRecoveryBlocker(reason: PlanStartRecoveryReason): string {
  return `${PLAN_START_RECOVERY_BLOCKER_PREFIX}${reason}`;
}

export function planStartRecoveryReasonFromBlocker(value: string | null): PlanStartRecoveryReason | null {
  if (value?.startsWith(PLAN_START_RECOVERY_BLOCKER_PREFIX) !== true) return null;
  const reason = value.slice(PLAN_START_RECOVERY_BLOCKER_PREFIX.length);
  return PLAN_START_RECOVERY_REASONS.includes(reason as PlanStartRecoveryReason)
    ? reason as PlanStartRecoveryReason
    : null;
}

export type PlanStartRecoveryAction =
  | 'continue_same_plan'
  | 'revise_plan'
  | 'restart_same_plan'
  | 'revise_then_restart'
  | 'use_oduno_skill_set'
  | 'use_zenki_skill_set'
  | 'revalidate_skill_sets'
  | 'cancel';

export interface UserFacingPlanRecoveryOption {
  action: PlanStartRecoveryAction;
  label: string;
  recommended: boolean;
  whenToChoose: string;
  whatHappens: string;
  advantages?: string[];
  disadvantages?: string[];
}

export interface UserFacingPlanRecovery {
  presentationVersion: 1;
  whatHappened: string;
  workState: string;
  resolution: string;
  skillSetDifference?: SkillRequirementDifference;
  options: UserFacingPlanRecoveryOption[];
}

export interface PlanStartRecovery {
  code: typeof PLAN_START_RECOVERY_CODE;
  reason: PlanStartRecoveryReason;
  userFacingRecovery: UserFacingPlanRecovery;
  effect: {
    mutationApplied: false;
    continuationPaused: true;
    planPersisted: false;
    advisoryConsumed: false;
    operationReceiptCreated: false;
    implementationStarted: false;
  };
  retry: { sameRunAllowed: boolean; requiresUserChoice: true };
}

const RECOVERY_EFFECT = {
  mutationApplied: false,
  continuationPaused: true,
  planPersisted: false,
  advisoryConsumed: false,
  operationReceiptCreated: false,
  implementationStarted: false,
} as const;

const NO_NEW_WORK = 'Starting this plan did not begin new work or make additional code changes.';
export const MAX_USER_FACING_RECOVERY_JSON_BYTES = 64 * 1024;

function assertSafeRecoveryProjection(projection: UserFacingPlanRecovery): void {
  if (findSecretInValue(projection) !== undefined) {
    throw new KiokukoError('VALIDATION_ERROR', 'Plan recovery display contains unsafe content');
  }
  if (Buffer.byteLength(canonicalJson(projection), 'utf8') > MAX_USER_FACING_RECOVERY_JSON_BYTES) {
    throw new KiokukoError('VALIDATION_ERROR', 'Plan recovery display is too large');
  }
}

export function buildPlanStartRecovery(reason: PlanStartRecoveryReason): PlanStartRecovery {
  if (reason === 'role_skill_set_conflict') {
    throw new KiokukoError('VALIDATION_ERROR', 'Role Skill-set recovery requires a bounded conflict projection');
  }
  if (reason === 'environment_information_missing') {
    return {
      code: PLAN_START_RECOVERY_CODE,
      reason,
      effect: RECOVERY_EFFECT,
      retry: { sameRunAllowed: true, requiresUserChoice: true },
      userFacingRecovery: {
        presentationVersion: 1,
        whatHappened: 'Information about the features available in this environment was not carried into the plan.',
        workState: NO_NEW_WORK,
        resolution: 'Attach the current environment information to continue with the same plan.',
        options: [
          {
            action: 'continue_same_plan',
            label: 'Continue with the same plan',
            recommended: true,
            whenToChoose: 'The plan is still correct and only the current environment information needs to be attached.',
            whatHappens: 'The current environment information is attached automatically, and the same attempt continues.',
          },
          {
            action: 'revise_plan',
            label: 'Review the plan',
            recommended: false,
            whenToChoose: 'You want to change the scope, work items, or verification before continuing.',
            whatHappens: 'You are asked what to change, and implementation does not start until you answer.',
          },
          {
            action: 'cancel',
            label: 'Cancel',
            recommended: false,
            whenToChoose: 'You no longer want this work to continue.',
            whatHappens: 'The current attempt is cancelled, and no replacement attempt is created.',
          },
        ],
      },
    };
  }
  if (reason === 'previous_attempt_ended') {
    return {
      code: PLAN_START_RECOVERY_CODE,
      reason,
      effect: RECOVERY_EFFECT,
      retry: { sameRunAllowed: false, requiresUserChoice: true },
      userFacingRecovery: {
        presentationVersion: 1,
        whatHappened: 'Required environment information was not included when this plan was submitted, so this attempt has ended.',
        workState: NO_NEW_WORK,
        resolution: 'The plan itself can be used to start a new attempt with the current environment.',
        options: [
          {
            action: 'restart_same_plan',
            label: 'Restart with the same plan',
            recommended: true,
            whenToChoose: 'The ended attempt\'s plan is still correct and should be reused.',
            whatHappens: 'The ended attempt stays unchanged, and a new attempt starts with the current environment and the same agreed plan.',
          },
          {
            action: 'revise_then_restart',
            label: 'Review the plan before restarting',
            recommended: false,
            whenToChoose: 'You want to change the scope, work items, or verification before creating a replacement.',
            whatHappens: 'You are asked what to change; the ended attempt stays unchanged, and a new attempt starts with the current environment and revised plan only after you answer.',
          },
          {
            action: 'cancel',
            label: 'Cancel',
            recommended: false,
            whenToChoose: 'You do not want to restart the work.',
            whatHappens: 'The ended attempt remains ended, and no new attempt is created.',
          },
        ],
      },
    };
  }
  return {
    code: PLAN_START_RECOVERY_CODE,
    reason,
    effect: RECOVERY_EFFECT,
    retry: { sameRunAllowed: false, requiresUserChoice: true },
    userFacingRecovery: {
      presentationVersion: 1,
      whatHappened: 'The features available in this environment have changed since this plan was created.',
      workState: NO_NEW_WORK,
      resolution: 'Start a new attempt using the current environment.',
      options: [
        {
          action: 'restart_same_plan',
          label: 'Restart the same plan in the current environment',
          recommended: true,
          whenToChoose: 'The plan is still correct and only the available features have changed.',
          whatHappens: 'The current attempt is cancelled, and a new attempt starts with the current environment and the same agreed plan.',
        },
        {
          action: 'revise_then_restart',
          label: 'Review the plan before restarting',
          recommended: false,
          whenToChoose: 'The changed features should alter the scope, work items, or verification.',
          whatHappens: 'You are asked what to change; after you answer, the current attempt is cancelled and a new attempt starts with the current environment and revised plan.',
        },
        {
          action: 'cancel',
          label: 'Cancel',
          recommended: false,
          whenToChoose: 'You no longer want this work to continue.',
          whatHappens: 'The current attempt is cancelled, and no replacement attempt is created.',
        },
      ],
    },
  };
}

export function buildRoleSkillSetRecovery(input: {
  odunoRequirements: readonly SkillRequirement[];
  zenkiRequirements: readonly SkillRequirement[];
  zenkiRequiredSkillsAvailable: boolean;
}): PlanStartRecovery {
  const odunoRequirements = normalizeSkillRequirementSet(input.odunoRequirements);
  const zenkiRequirements = normalizeSkillRequirementSet(input.zenkiRequirements);
  const difference = skillRequirementDifference(odunoRequirements, zenkiRequirements);
  if (skillRequirementDifferenceIsEmpty(difference)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Role Skill-set recovery requires a non-empty difference');
  }
  const recommendZenki = input.zenkiRequiredSkillsAvailable
    && zenkiRequirementsPreserveOduno(odunoRequirements, zenkiRequirements);
  const projection: UserFacingPlanRecovery = {
    presentationVersion: 1,
    whatHappened: 'The Skill set selected when Enno-Oduno defined the ideal differs from the Skill set Zenki found necessary while creating the implementation plan.',
    workState: NO_NEW_WORK,
    resolution: 'Review the Skill differences and choose which approach should control the next step.',
    skillSetDifference: difference,
    options: [
      {
        action: 'use_oduno_skill_set',
        label: 'Use Enno-Oduno\'s original Skill set',
        recommended: false,
        whenToChoose: 'Preserving the original objective and constraints matters more than Zenki\'s implementation-specific additions.',
        whatHappens: 'The same attempt returns to Zenki, which must create a new plan that exactly matches Enno-Oduno\'s Skill requirements. Implementation does not start yet.',
        advantages: ['Preserves the Skill choices derived from the original objective and constraints.'],
        disadvantages: ['Zenki cannot use implementation-specific Skills it identified, so the plan must be rebuilt and may lose useful specialization.'],
      },
      {
        action: 'use_zenki_skill_set',
        label: 'Use the Skill set identified by Zenki',
        recommended: recommendZenki,
        whenToChoose: 'Zenki\'s repository and implementation analysis should control the executable plan.',
        whatHappens: 'The exact Zenki plan that produced this comparison is resubmitted and proceeds to normal plan confirmation.',
        advantages: ['Uses the Skill requirements informed by repository structure, implementation steps, and verification needs.'],
        disadvantages: ['The execution approach may be broader than the original ideal, and unavailable required Skills still prevent plan start.'],
      },
      {
        action: 'revalidate_skill_sets',
        label: 'Revalidate both Skill sets',
        recommended: !recommendZenki,
        whenToChoose: 'The difference removes, weakens, or cannot verify an important requirement, or neither proposal is clearly safe.',
        whatHappens: 'The same attempt restarts from Enno-Oduno\'s ideal. Intake answers are preserved, but the current ideal and Zenki draft are replaced.',
        advantages: ['Lets both roles reconsider the current evidence and resolve omissions or incompatible requirements.'],
        disadvantages: ['Ideal derivation and planning are repeated, so completion takes longer.'],
      },
      {
        action: 'cancel',
        label: 'Cancel',
        recommended: false,
        whenToChoose: 'You no longer want this work to continue.',
        whatHappens: 'The current attempt is cancelled, no replacement is created, and no code changes are made by this recovery.',
        advantages: ['Stops without beginning additional work or code changes.'],
        disadvantages: ['The requested work remains incomplete.'],
      },
    ],
  };
  assertSafeRecoveryProjection(projection);
  return {
    code: PLAN_START_RECOVERY_CODE,
    reason: 'role_skill_set_conflict',
    effect: RECOVERY_EFFECT,
    retry: { sameRunAllowed: true, requiresUserChoice: true },
    userFacingRecovery: projection,
  };
}

export function planStartRecoveryError(reason: PlanStartRecoveryReason): KiokukoError {
  return new KiokukoError('CONFLICT', 'Plan start requires an explicit recovery choice', {
    [PLAN_START_RECOVERY_DETAIL_KEY]: reason,
  });
}

export function renderPlanStartRecovery(recovery: PlanStartRecovery): string {
  const projection = recovery.userFacingRecovery;
  const difference = projection.skillSetDifference;
  const requirement = (item: SkillRequirement): string => `${item.name} (${item.required ? 'required' : 'optional'}; ${item.purposes.join(', ')})`;
  const differenceLines = difference === undefined ? [] : [
    'Skill differences:',
    ...(difference.addedByZenki.length === 0 ? [] : [`- Added by Zenki: ${difference.addedByZenki.map(requirement).join('; ')}`]),
    ...(difference.omittedByZenki.length === 0 ? [] : [`- Omitted by Zenki: ${difference.omittedByZenki.map(requirement).join('; ')}`]),
    ...(difference.changed.length === 0 ? [] : difference.changed.map((change) => (
      `- Changed ${change.name}: Enno-Oduno ${requirement(change.oduno)}; Zenki ${requirement(change.zenki)}`
    ))),
    '',
  ];
  return [
    projection.whatHappened,
    projection.workState,
    projection.resolution,
    '',
    ...differenceLines,
    ...projection.options.flatMap((option, index) => [
      `${index + 1}. ${option.label}${option.recommended ? ' (Recommended)' : ''}`,
      ...(option.advantages === undefined ? [] : option.advantages.map((advantage) => `   Advantage: ${advantage}`)),
      ...(option.disadvantages === undefined ? [] : option.disadvantages.map((disadvantage) => `   Disadvantage: ${disadvantage}`)),
      `   Choose this when: ${option.whenToChoose}`,
      `   What happens: ${option.whatHappens}`,
    ]),
  ].join('\n');
}
