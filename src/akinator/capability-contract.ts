import * as z from 'zod/v4';
import { KiokukoError } from '../errors.js';
import { normalizeCapabilityCatalog, MAX_CAPABILITY_ITEMS, MAX_CAPABILITY_NAME_CHARS } from './capabilities.js';
export const capabilityDescriptorSchema = z.object({
  kind: z.enum(['skill', 'mcp_tool']),
  name: z.string().min(1).refine(v => Array.from(v).length <= MAX_CAPABILITY_NAME_CHARS && v.trim() === v && !/[\p{Cc}\p{Cf}]/u.test(v)),
  description: z.string().optional(),
}).strict();
export const capabilityCatalogSchema = z.array(capabilityDescriptorSchema).max(MAX_CAPABILITY_ITEMS);
export class CapabilityPreparationError extends KiokukoError {
  constructor(readonly preparationDetails: Record<string, unknown>) {
    super('VALIDATION_ERROR', 'Capability preparation rejected before run creation', preparationDetails);
  }
}
/** Validate the complete catalog before opening a task or performing retrieval. */
export function assertPreparationCapabilities(input: unknown): void {
  if (input === undefined) {
    throw new CapabilityPreparationError({ runCreated: false, reason: 'required_capability_unavailable',
      requiredSkill: 'kiokuko-soul', catalogAvailability: 'unknown', retry: 'supply_available_local_skill_and_retry_prepare' });
  }
  const parsed = capabilityCatalogSchema.safeParse(input);
  const normalized = normalizeCapabilityCatalog(input);
  if (!parsed.success || normalized.availability === 'unknown') {
    throw new CapabilityPreparationError({ runCreated: false, reason: 'invalid_capability_catalog', retry: 'correct_catalog_and_retry_prepare',
      issues: parsed.success ? [{ index: null, reason: 'catalog_budget_exceeded' }] : parsed.error.issues.slice(0, 20).map(i => ({ index: typeof i.path[0] === 'number' ? i.path[0] : null, reason: i.code })) });
  }
  if (!normalized.skills.some(s => s.name === 'kiokuko-soul')) {
    throw new CapabilityPreparationError({ runCreated: false, reason: 'required_capability_unavailable', requiredSkill: 'kiokuko-soul', retry: 'supply_available_local_skill_and_retry_prepare' });
  }
}
