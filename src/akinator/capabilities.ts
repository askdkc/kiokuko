import type { TaskProfile } from './types.js';

export const CAPABILITY_KINDS = ['skill', 'mcp_tool'] as const;
export type CapabilityKind = (typeof CAPABILITY_KINDS)[number];

export interface CapabilityDescriptor {
  kind: CapabilityKind;
  name: string;
  description?: string;
}

export interface CapabilityRecommendation {
  kind: CapabilityKind;
  name: string;
  availability: 'available' | 'missing' | 'unknown';
  reason: string;
  source: 'akinator_policy' | 'catalog_similarity';
}

export interface CapabilityResolution {
  catalogProvided: boolean;
  availableSkillCount: number | null;
  externalSkillFallback: ExternalSkillFallbackDecision;
  recommendations: CapabilityRecommendation[];
}

export interface ExternalSkillFallbackDecision {
  eligible: boolean;
  source: 'https://github.com/mattpocock/skills';
  reason: 'no_skills_available' | 'skills_available' | 'capability_catalog_unknown';
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
};

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

function desiredSkills(recommendedTags: string[]): string[] {
  return [...new Set(recommendedTags
    .filter((tag) => tag.startsWith('skill:'))
    .map((tag) => normalizedName(tag.slice('skill:'.length)))
    .filter(Boolean))];
}

function matchingSkill(catalog: CapabilityDescriptor[], desired: string): CapabilityDescriptor | undefined {
  return catalog.find((candidate) => candidate.kind === 'skill' && nameAliases(candidate.name).has(desired));
}

export function decideExternalSkillFallback(capabilities?: CapabilityDescriptor[]): ExternalSkillFallbackDecision {
  const availableSkillCount = capabilities?.filter((capability) => capability.kind === 'skill').length;
  if (availableSkillCount === undefined) {
    return {
      eligible: false,
      source: 'https://github.com/mattpocock/skills',
      reason: 'capability_catalog_unknown',
    };
  }
  return {
    eligible: availableSkillCount === 0,
    source: 'https://github.com/mattpocock/skills',
    reason: availableSkillCount === 0 ? 'no_skills_available' : 'skills_available',
  };
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
    .filter((candidate) => candidate.kind === 'mcp_tool'
      || ![...nameAliases(candidate.name)].some((alias) => desiredSkillNames.has(alias)))
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
  capabilities?: CapabilityDescriptor[];
}): CapabilityResolution {
  const catalogProvided = input.capabilities !== undefined;
  const catalog = input.capabilities ?? [];
  const externalSkillFallback = decideExternalSkillFallback(input.capabilities);
  const desired = desiredSkills(input.recommendedTags);
  const desiredSkillNames = new Set(desired);
  const skills: CapabilityRecommendation[] = desired.map((desiredName) => {
    const matched = matchingSkill(catalog, desiredName);
    return {
      kind: 'skill',
      name: matched?.name ?? desiredName,
      availability: matched ? 'available' : catalogProvided ? 'missing' : 'unknown',
      reason: SKILL_REASONS[desiredName] ?? 'The Akinator task policy recommends this workflow.',
      source: 'akinator_policy',
    };
  });
  return {
    catalogProvided,
    availableSkillCount: catalogProvided ? catalog.filter((capability) => capability.kind === 'skill').length : null,
    externalSkillFallback,
    recommendations: [...skills, ...relevantCatalogCapabilities(input.task, input.profile, catalog, desiredSkillNames)],
  };
}
