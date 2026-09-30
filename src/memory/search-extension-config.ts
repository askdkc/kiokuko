import { KiokukoError } from '../errors.js';
import type { RelatedSearchMode } from './hybrid-retrieval.js';

export type SearchExtensionMode = Exclude<RelatedSearchMode, 'off'> | 'off';

export function readSearchExtensionMode(env: NodeJS.ProcessEnv = process.env): SearchExtensionMode {
  const mode = env.KIOKUKO_SEARCH_EXPANSION_MODE ?? 'off';
  if (mode === 'off' || mode === 'observe' || mode === 'active') return mode;
  throw new KiokukoError('VALIDATION_ERROR', 'KIOKUKO_SEARCH_EXPANSION_MODE must be off, observe, or active');
}

export function effectiveRelatedSearchMode(
  requested: RelatedSearchMode | undefined,
  env: NodeJS.ProcessEnv = process.env,
): RelatedSearchMode {
  const configured = readSearchExtensionMode(env);
  if (requested === 'off') return 'off';
  if (requested === undefined) return configured;
  if (configured === 'off') return 'off';
  if (configured === 'observe' && requested === 'active') return 'observe';
  return requested;
}
