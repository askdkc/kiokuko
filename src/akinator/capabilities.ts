import type { TaskProfile } from './types.js';
import { STANDARD_UI_SKILL_NAME } from '../setup/standard-skills.js';

export const CAPABILITY_KINDS = ['skill', 'mcp_tool'] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export const MAX_CAPABILITY_DESCRIPTION_CHARS = 2_000;
export const MAX_RAW_CAPABILITY_DESCRIPTION_CHARS = 64_000;
export const MAX_CAPABILITY_NAME_CHARS = 300;
export const MAX_CAPABILITY_ITEMS = 200;
export const MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS = 512_000;

export interface CapabilityDescriptor {
  kind: CapabilityKind;
  name: string;
  description?: string;
}

export type CapabilityCatalogAvailability = 'known-empty' | 'known-nonempty' | 'unknown';

export interface CapabilityCatalogDiagnostics {
  received: number;
  accepted: number;
  truncated: number;
  dropped: number;
}

export interface NormalizedCapabilityCatalog {
  availability: CapabilityCatalogAvailability;
  skills: CapabilityDescriptor[];
  tools: CapabilityDescriptor[];
  diagnostics: CapabilityCatalogDiagnostics;
  budgetExceeded: boolean;
}

export interface CapabilityWarning {
  code: 'CAPABILITY_CATALOG_COMPACTED' | 'CAPABILITY_CATALOG_ITEMS_DROPPED' | 'CAPABILITY_CATALOG_BUDGET_EXCEEDED' | 'CAPABILITY_CATALOG_UNAVAILABLE';
  message: string;
}

export interface CapabilityRecommendation {
  kind: CapabilityKind;
  name: string;
  availability: 'available' | 'missing' | 'unknown';
  reason: string;
  source: 'akinator_policy' | 'catalog_similarity';
}

export interface CapabilityResolution {
  availability: CapabilityCatalogAvailability;
  catalogProvided: boolean;
  availableSkillCount: number | null;
  diagnostics: CapabilityCatalogDiagnostics;
  warnings: CapabilityWarning[];
  externalSkillFallback: ExternalSkillFallbackDecision;
  recommendations: CapabilityRecommendation[];
}

export interface ExternalSkillFallbackDecision {
  eligible: boolean;
  source: 'https://github.com/mattpocock/skills';
  reason: 'no_skills_available' | 'skills_available' | 'capability_catalog_nonempty' | 'capability_catalog_unknown';
}

export function boundedCodePointLength(value: string, limit: number): number {
  if (limit < 0) return 0;
  let length = 0;
  for (const _point of value) {
    length += 1;
    if (length > limit) return length;
  }
  return length;
}

export function truncateCodePoints(value: string, max: number): string {
  if (max <= 0) return '';
  const points = Array.from(value);
  if (points.length <= max) return value;
  return `${points.slice(0, max - 1).join('')}…`;
}

export function compactCapabilityDescription(value: string): { description: string; truncated: boolean } {
  const normalized = value
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, (character) => /\s/u.test(character) ? ' ' : '')
    .replace(/\s+/gu, ' ')
    .trim();
  const description = truncateCodePoints(normalized, MAX_CAPABILITY_DESCRIPTION_CHARS);
  return { description, truncated: description !== normalized };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCapabilityKind(value: unknown): value is CapabilityKind {
  return typeof value === 'string' && CAPABILITY_KINDS.includes(value as CapabilityKind);
}

function normalizedCatalogWarningList(
  availability: CapabilityCatalogAvailability,
  diagnostics: CapabilityCatalogDiagnostics,
  catalogWasSupplied: boolean,
  budgetExceeded: boolean,
): CapabilityWarning[] {
  const warnings: CapabilityWarning[] = [];
  if (diagnostics.truncated > 0) {
    warnings.push({
      code: 'CAPABILITY_CATALOG_COMPACTED',
      message: 'Some capability descriptions were shortened or omitted.',
    });
  }
  if (diagnostics.dropped > 0) {
    warnings.push({
      code: 'CAPABILITY_CATALOG_ITEMS_DROPPED',
      message: 'Some capability catalog items were ignored.',
    });
  }
  if (budgetExceeded) {
    warnings.push({
      code: 'CAPABILITY_CATALOG_BUDGET_EXCEEDED',
      message: 'Some capability catalog data was omitted because the catalog exceeded its processing budget.',
    });
  }
  if (catalogWasSupplied && availability === 'unknown') {
    warnings.push({
      code: 'CAPABILITY_CATALOG_UNAVAILABLE',
      message: 'The capability catalog could not be safely classified.',
    });
  }
  return warnings;
}

function validateCapabilityHeader(value: unknown): Pick<CapabilityDescriptor, 'kind' | 'name'> | null {
  if (!isPlainRecord(value) || !isCapabilityKind(value.kind) || typeof value.name !== 'string') return null;
  if (boundedCodePointLength(value.name, MAX_CAPABILITY_NAME_CHARS) > MAX_CAPABILITY_NAME_CHARS
    || value.name.trim().length === 0
    || /[\p{Cc}\p{Cf}]/u.test(value.name)) return null;
  return { kind: value.kind, name: value.name };
}

export function normalizeCapabilityCatalog(input: unknown): NormalizedCapabilityCatalog {
  const emptyDiagnostics = { received: 0, accepted: 0, truncated: 0, dropped: 0 };
  if (input === undefined) {
    return { availability: 'unknown', skills: [], tools: [], diagnostics: emptyDiagnostics, budgetExceeded: false };
  }
  if (!Array.isArray(input)) {
    return { availability: 'unknown', skills: [], tools: [], diagnostics: emptyDiagnostics, budgetExceeded: false };
  }

  const diagnostics: CapabilityCatalogDiagnostics = {
    received: input.length,
    accepted: 0,
    truncated: 0,
    dropped: Math.max(0, input.length - MAX_CAPABILITY_ITEMS),
  };
  const skills: CapabilityDescriptor[] = [];
  const tools: CapabilityDescriptor[] = [];
  const processCount = Math.min(input.length, MAX_CAPABILITY_ITEMS);
  let remaining = MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS;
  let budgetExceeded = false;
  const accept = (descriptor: CapabilityDescriptor, truncated: boolean): void => {
    diagnostics.accepted += 1;
    if (truncated) diagnostics.truncated += 1;
    (descriptor.kind === 'skill' ? skills : tools).push(descriptor);
  };
  for (let index = 0; index < processCount; index += 1) {
    const item = input[index];
    const header = validateCapabilityHeader(item);
    if (header === null) {
      diagnostics.dropped += 1;
      continue;
    }
    const nameCost = boundedCodePointLength(header.name, remaining);
    if (nameCost > remaining) {
      diagnostics.dropped += processCount - index;
      budgetExceeded = true;
      break;
    }
    remaining -= nameCost;
    const descriptor: CapabilityDescriptor = { ...header };
    if (!isPlainRecord(item) || item.description === undefined) {
      accept(descriptor, false);
      continue;
    }
    if (typeof item.description !== 'string') {
      accept(descriptor, true);
      continue;
    }
    const scanLimit = Math.min(remaining, MAX_RAW_CAPABILITY_DESCRIPTION_CHARS);
    const descriptionCost = boundedCodePointLength(item.description, scanLimit);
    if (descriptionCost > scanLimit) {
      accept(descriptor, true);
      if (remaining <= MAX_RAW_CAPABILITY_DESCRIPTION_CHARS) {
        diagnostics.dropped += processCount - index - 1;
        budgetExceeded = true;
        break;
      }
      remaining -= descriptionCost;
      continue;
    }
    remaining -= descriptionCost;
    const compacted = compactCapabilityDescription(item.description);
    if (compacted.description.length > 0) descriptor.description = compacted.description;
    accept(descriptor, compacted.truncated || (item.description.length > 0 && compacted.description.length === 0));
  }
  const availability: CapabilityCatalogAvailability = input.length === 0 ? 'known-empty' : 'known-nonempty';
  return { availability, skills, tools, diagnostics, budgetExceeded };
}

const TASK_TOOL_TERMS: Record<NonNullable<TaskProfile['taskType']>, string[]> = {
  build: ['build', 'code', 'github', 'gitlab', 'repository', 'test'],
  debug: ['browser', 'debug', 'error', 'github', 'log', 'test'],
  research: ['citation', 'docs', 'documentation', 'research', 'search', 'web'],
  review: ['code', 'diff', 'github', 'gitlab', 'pull', 'review'],
  devops: ['cloud', 'deploy', 'docker', 'kubernetes', 'log', 'monitor'],
  writing: ['docs', 'document', 'markdown', 'publish', 'writing'],
  analysis: ['analysis', 'database', 'dataset', 'query', 'spreadsheet', 'sql'],
};

const SKILL_REASONS: Record<string, string> = {
  tdd: 'The build task benefits from a test-first implementation workflow.',
  'diagnosing-bugs': 'The debugging task benefits from a reproducible diagnosis workflow.',
  research: 'The research task requires source-grounded findings.',
  'code-review': 'The review task benefits from a structured code-review workflow.',
  [STANDARD_UI_SKILL_NAME]: 'The task explicitly involves UI implementation, design, or review and benefits from Kiokuko\'s interaction-state and accessibility contract.',
};

const EXPLICIT_UI_INTENT = /(?:\b(?:ui|ux|frontend|front-end|swiftui|accessibility)\b|\buser[ -]?interface\b|\b(?:app|web)[ -]?(?:screen|interface|view|page)\b|\bscreen(?:s)?\b|ユーザーインターフェース|インターフェース|フロントエンド|アクセシビリティ|画面|操作(?:性|設計|フロー)|ボタン|フォーム|モーダル|ダイアログ|ナビゲーション)/iu;
const EXCLUDED_UI_SCOPE = /(?:\bbackend[- ]only\b|\bserver[- ]side only\b|\bimage generation only\b|バックエンド(?:だけ|のみ)|画像生成(?:だけ|のみ))/iu;

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll('_', '-');
}

function nameAliases(value: string): Set<string> {
  const normalized = normalizedName(value);
  const segments = normalized.split(/(?:::|:|\/)/u).filter(Boolean);
  return new Set([normalized, segments.at(-1) ?? normalized]);
}

function tokens(value: string): Set<string> {
  const found = value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) ?? [];
  return new Set(found.flatMap((token) => {
    const normalized = token.replaceAll('_', '-');
    return [normalized, ...normalized.split('-')];
  }).filter((token) => token.length > 2));
}

function desiredSkills(input: { task: string; profile: TaskProfile; recommendedTags: string[] }): string[] {
  const skillNames = input.recommendedTags
    .filter((tag) => tag.startsWith('skill:'))
    .map((tag) => normalizedName(tag.slice('skill:'.length)))
    .filter(Boolean);
  const taskScope = [input.task, input.profile.target ?? '', input.profile.expected ?? '', input.profile.constraints ?? ''].join(' ');
  if (!EXCLUDED_UI_SCOPE.test(taskScope) && EXPLICIT_UI_INTENT.test(taskScope)) skillNames.push(STANDARD_UI_SKILL_NAME);
  return [...new Set(skillNames)];
}

function matchingSkill(catalog: CapabilityDescriptor[], desired: string): CapabilityDescriptor | undefined {
  return catalog.find((candidate) => candidate.kind === 'skill' && nameAliases(candidate.name).has(desired));
}

function externalSkillFallbackForCatalog(catalog: NormalizedCapabilityCatalog): ExternalSkillFallbackDecision {
  if (catalog.availability === 'unknown') {
    return {
      eligible: false,
      source: 'https://github.com/mattpocock/skills',
      reason: 'capability_catalog_unknown',
    };
  }
  if (catalog.availability === 'known-empty') {
    return {
      eligible: true,
      source: 'https://github.com/mattpocock/skills',
      reason: 'no_skills_available',
    };
  }
  return {
    eligible: false,
    source: 'https://github.com/mattpocock/skills',
    reason: catalog.skills.length > 0 ? 'skills_available' : 'capability_catalog_nonempty',
  };
}

export function decideExternalSkillFallback(input?: unknown): ExternalSkillFallbackDecision {
  return externalSkillFallbackForCatalog(normalizeCapabilityCatalog(input));
}

function relevantCatalogCapabilities(
  task: string,
  profile: TaskProfile,
  catalog: CapabilityDescriptor[],
  desiredSkillNames: Set<string>,
): CapabilityRecommendation[] {
  const taskTokens = tokens([task, profile.target ?? '', profile.expected ?? '', profile.constraints ?? ''].join(' '));
  const roleTerms = new Set(profile.taskType ? TASK_TOOL_TERMS[profile.taskType] : []);
  return catalog
    .filter((candidate) => {
      if (candidate.kind === 'mcp_tool') return true;
      const aliases = nameAliases(candidate.name);
      if (aliases.has(STANDARD_UI_SKILL_NAME)) return false;
      return ![...aliases].some((alias) => desiredSkillNames.has(alias));
    })
    .map((candidate) => {
      const candidateTokens = tokens(`${candidate.name} ${candidate.description ?? ''}`);
      const matchedTaskTerms = [...taskTokens].filter((token) => candidateTokens.has(token));
      const matchedRoleTerms = [...roleTerms].filter((token) => candidateTokens.has(token));
      return {
        candidate,
        matchedTaskTerms,
        matchedRoleTerms,
        score: matchedTaskTerms.length * 3 + matchedRoleTerms.length,
      };
    })
    .filter(({ score, matchedTaskTerms, matchedRoleTerms }) => score >= 3 || (matchedTaskTerms.length > 0 && matchedRoleTerms.length > 0))
    .sort((left, right) => right.score - left.score || left.candidate.name.localeCompare(right.candidate.name))
    .slice(0, 5)
    .map(({ candidate, matchedTaskTerms, matchedRoleTerms }) => {
      const terms = [...new Set([...matchedTaskTerms, ...matchedRoleTerms])].slice(0, 5);
      return {
        kind: candidate.kind,
        name: candidate.name,
        availability: 'available',
        reason: `Available ${candidate.kind === 'skill' ? 'skill' : 'MCP tool'} metadata matches the task${terms.length > 0 ? ` (${terms.join(', ')})` : ''}.`,
        source: 'catalog_similarity',
      };
    });
}

export function resolveCapabilities(input: {
  task: string;
  profile: TaskProfile;
  recommendedTags: string[];
  capabilities?: unknown;
}): CapabilityResolution {
  const normalized = normalizeCapabilityCatalog(input.capabilities);
  const catalogProvided = normalized.availability !== 'unknown';
  const catalog = [...normalized.skills, ...normalized.tools];
  const externalSkillFallback = externalSkillFallbackForCatalog(normalized);
  const desired = desiredSkills(input);
  const desiredSkillNames = new Set(desired);
  const skills: CapabilityRecommendation[] = desired.map((desiredName) => {
    const matched = matchingSkill(catalog, desiredName);
    return {
      kind: 'skill',
      name: matched?.name ?? desiredName,
      availability: matched ? 'available' : normalized.availability === 'unknown' ? 'unknown' : 'missing',
      reason: SKILL_REASONS[desiredName] ?? 'The Akinator task policy recommends this workflow.',
      source: 'akinator_policy',
    };
  });
  return {
    availability: normalized.availability,
    catalogProvided,
    availableSkillCount: normalized.availability === 'unknown' ? null : normalized.skills.length,
    diagnostics: normalized.diagnostics,
    warnings: normalizedCatalogWarningList(normalized.availability, normalized.diagnostics, input.capabilities !== undefined, normalized.budgetExceeded),
    externalSkillFallback,
    recommendations: [...skills, ...relevantCatalogCapabilities(input.task, input.profile, catalog, desiredSkillNames)],
  };
}
