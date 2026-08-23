import type { SqliteDatabase } from '../db/adapter.js';
import { canonicalContentHash, type JsonObject } from '../serialization/validate.js';
import { readEntry, type EntryRecord } from '../memory/entries.js';
import { ensureGlobalWorkspace, GLOBAL_WORKSPACE, resolveProjectWorkspace, type ResolvedProjectWorkspace } from '../memory/workspaces.js';
import { federatedEntries, type FederatedOrigin } from '../memory/federated-retrieval.js';
import type { TaskProfile } from '../akinator/types.js';
import { recordContextDelivery } from './delivery.js';
import { readRunIntakeLink } from '../akinator/store.js';
import { CONTEXT_SELECTION_REASON_ORDER } from './ranking.js';

export const SCOPED_CONTEXT_POLICY_VERSION = 'context-ranking-v3' as const;

export interface ScopedContextQuery {
  cwd?: string;
  project?: ResolvedProjectWorkspace;
  task: string;
  taskProfile: TaskProfile;
  recommendedTags?: string[];
  changedPaths?: string[];
  errorSignatures?: string[];
  limit?: number;
  characterBudget?: number;
  runId?: string;
}

export interface ScopedContextItem {
  entryId: string;
  revision: number;
  origin: FederatedOrigin;
  title: string;
  summary: string | null;
  bodyPreview: string;
  score: number;
  scoreComponents: {
    status: number;
    trust: number;
    confidence: number;
    retrieval: number;
    taskAffinity: number;
    recommendedTags: number;
    scopeAffinity: number;
    applicability: number;
    pathOverlap: number;
    errorSignature: number;
    exactSignal: number;
    feedback: number;
    recency: number;
    contradiction: number;
  };
  selectionReasons: string[];
  metadata: {
    storedData: true;
    untrusted: true;
    instructions: false;
  };
}

export interface ScopedContextResult {
  project: ResolvedProjectWorkspace | null;
  taskProfileHash: string;
  queryHash: string;
  policyVersion: typeof SCOPED_CONTEXT_POLICY_VERSION;
  items: ScopedContextItem[];
  deliveryId: string | null;
  truncated: boolean;
  untrusted: true;
}

const MAX_LIMIT = 100;
const MAX_BUDGET = 100_000;

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function textFor(query: ScopedContextQuery): string {
  return [
    query.task,
    query.taskProfile.taskType ?? '',
    query.taskProfile.target ?? '',
    query.taskProfile.expected ?? '',
    query.taskProfile.constraints ?? '',
    ...(query.recommendedTags ?? []),
    ...(query.changedPaths ?? []),
    ...(query.errorSignatures ?? []),
  ].join('\n');
}

function scopeObject(entry: EntryRecord): Record<string, unknown> {
  return entry.scope;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(normalize) : [];
}

function applicabilityScore(entry: EntryRecord, queryText: string, origin: FederatedOrigin): { score: number; reasons: string[]; conflict: boolean } {
  if (origin === 'project') return { score: 0, reasons: [], conflict: false };
  const scope = scopeObject(entry);
  const applicability = typeof scope.applicability === 'object' && scope.applicability !== null && !Array.isArray(scope.applicability)
    ? scope.applicability as Record<string, unknown>
    : undefined;
  if (applicability === undefined) return origin === 'global' ? { score: -4, reasons: ['unscoped_global_prior'], conflict: false } : { score: -8, reasons: ['applicability_unknown'], conflict: false };
  const haystack = normalize(queryText);
  const values = [
    ...stringList(applicability.languages),
    ...stringList(applicability.databases),
    ...stringList(applicability.runtimes),
    ...stringList(applicability.tools),
    ...stringList(applicability.platforms),
    ...(Array.isArray(applicability.frameworks) ? applicability.frameworks.flatMap((item) => typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string' ? [normalize((item as { name: string }).name)] : []) : []),
  ];
  if (values.length === 0) return origin === 'global' ? { score: -2, reasons: ['unscoped_global_prior'], conflict: false } : { score: -8, reasons: ['applicability_unknown'], conflict: false };
  const matches = values.filter((value) => haystack.includes(value)).length;
  const likelyUnrelated = /\b(?:swiftui|ios|android|kotlin|rust|django|rails|laravel|postgres(?:ql)?|mysql|react|vue)\b/giu;
  const queryEcosystems = [...haystack.matchAll(likelyUnrelated)].map((match) => match[0].toLowerCase());
  const explicitConflict = queryEcosystems.length > 0 && values.some((value) => !queryEcosystems.includes(value) && /^(?:laravel|postgresql?|swiftui|django|rails|rust|kotlin|mysql|react|vue)$/u.test(value));
  if (explicitConflict && matches === 0) return { score: -100, reasons: ['applicability_mismatch'], conflict: true };
  return {
    score: Math.min(18, matches * 9),
    reasons: matches > 0 ? ['applicability_match'] : ['applicability_unknown'],
    conflict: false,
  };
}

function entryScore(entry: EntryRecord, origin: FederatedOrigin, retrieval: number, exact: boolean, query: ScopedContextQuery, queryText: string): ScopedContextItem {
  const scope = origin;
  const status = entry.status === 'verified' ? 100 : entry.status === 'candidate' ? 40 : 0;
  const trust = entry.trustLevel === 'system_verified' ? 30 : entry.trustLevel === 'source_verified' ? 25 : entry.trustLevel === 'user_asserted' ? 15 : 0;
  const confidence = Math.round(entry.confidence * 20);
  const scopeAffinity = scope === 'project' ? 9 : scope === 'ecosystem' ? 6 : 4;
  const applicability = applicabilityScore(entry, queryText, origin);
  const exactSignal = exact ? 24 : 0;
  const score = status + trust + confidence + retrieval + scopeAffinity + applicability.score + exactSignal;
  const reasons = [scope === 'project' ? 'project_origin' : scope === 'ecosystem' ? 'ecosystem_origin' : 'global_origin', ...(entry.status === 'verified' ? ['verified'] : ['candidate']), ...applicability.reasons, ...(exact ? ['exact_signal_match'] : [])];
  return {
    entryId: entry.id,
    revision: entry.revision,
    origin: scope,
    title: entry.title,
    summary: entry.summary,
    bodyPreview: entry.summary ?? entry.body,
    score,
    scoreComponents: {
      status,
      trust,
      confidence,
      retrieval: Math.round(retrieval),
      taskAffinity: 0,
      recommendedTags: 0,
      scopeAffinity,
      applicability: applicability.score,
      pathOverlap: 0,
      errorSignature: 0,
      exactSignal,
      feedback: 0,
      recency: 0,
      contradiction: 0,
    },
    selectionReasons: [...new Set(reasons)],
    metadata: { storedData: true, untrusted: true, instructions: false },
  };
}

function feedbackScore(database: SqliteDatabase, entryId: string): { score: number; reasons: string[] } {
  const rows = database.prepare(`
    SELECT verdict, COUNT(DISTINCT run_id) AS runs
    FROM context_feedback
    WHERE entry_id = ?
    GROUP BY verdict
  `).all<{ verdict: string; runs: number }>(entryId);
  let score = 0;
  const reasons: string[] = [];
  for (const row of rows) {
    const influence = Math.min(2, Number(row.runs));
    if (row.verdict === 'helpful') { score += 3 * influence; reasons.push('helpful_feedback'); }
    if (row.verdict === 'irrelevant') { score -= 2 * influence; reasons.push('irrelevant_feedback'); }
    if (row.verdict === 'stale') { score -= 3 * influence; reasons.push('stale_feedback'); }
    if (row.verdict === 'conflicting') { score -= 3 * influence; reasons.push('conflicting_feedback'); }
  }
  return { score: Math.max(-6, Math.min(6, score)), reasons };
}

export async function queryScopedContext(database: SqliteDatabase, raw: ScopedContextQuery): Promise<ScopedContextResult> {
  const project = raw.project ?? await resolveProjectWorkspace(database, raw.cwd);
  ensureGlobalWorkspace(database);
  const limit = raw.limit ?? 20;
  const characterBudget = raw.characterBudget ?? 8_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT || !Number.isSafeInteger(characterBudget) || characterBudget < 1 || characterBudget > MAX_BUDGET) {
    throw new Error('Scoped context bounds are invalid');
  }
  const queryText = textFor(raw);
  const taskProfileHash = canonicalContentHash(raw.taskProfile);
  const queryHash = canonicalContentHash({ task: raw.task, taskProfile: raw.taskProfile, recommendedTags: raw.recommendedTags ?? [], changedPaths: raw.changedPaths ?? [], errorSignatures: raw.errorSignatures ?? [] });
  const candidates = new Map<string, ScopedContextItem>();
  const federated = project === undefined ? [] : await federatedEntries(database, { project, query: queryText, limit: 200 });
  for (const hit of federated) {
      const entry = hit.entry;
      const item = entryScore(entry, hit.origin, hit.score, hit.selectionReasons.includes('exact_signal_match'), raw, queryText);
      item.selectionReasons.push(...hit.selectionReasons);
      item.selectionReasons = [...new Set(item.selectionReasons)];
      const feedback = feedbackScore(database, entry.id);
      item.score += feedback.score;
      item.scoreComponents.feedback = feedback.score;
      item.selectionReasons.push(...feedback.reasons);
      if (item.score <= -50) continue;
      const previous = candidates.get(item.entryId);
      if (previous === undefined || item.score > previous.score) candidates.set(item.entryId, item);
  }
  const ordered = [...candidates.values()].sort((left, right) => right.score - left.score || left.entryId.localeCompare(right.entryId));
  const items: ScopedContextItem[] = [];
  let remaining = characterBudget;
  for (const item of ordered.slice(0, limit + 1)) {
    const body = Array.from(item.bodyPreview).slice(0, remaining).join('');
    const cost = Array.from(item.title).length + Array.from(item.summary ?? '').length + body.length;
    if (remaining <= 0) break;
    items.push({ ...item, bodyPreview: body, scoreComponents: { ...item.scoreComponents }, selectionReasons: [...item.selectionReasons] });
    remaining -= cost;
  }
  let deliveryId: string | null = null;
  if (raw.runId !== undefined) {
    const run = database.prepare('SELECT run_id, workspace, last_sequence, created_at FROM ledger_runs WHERE run_id = ?').get<{ run_id: string; workspace: string; last_sequence: number; created_at: string }>(raw.runId);
    if (!run || project === undefined || run.workspace !== project.workspace) throw new Error('Scoped context run is invalid');
    const link = readRunIntakeLink(database, { workspace: run.workspace, runId: raw.runId });
    // queryHash is intentionally stable, but delivery_id is a global primary
    // key. Include the run so the same successful reasoning path can recur in
    // independent runs without colliding, while replay within one run remains
    // idempotent.
    deliveryId = `context-${canonicalContentHash({ runId: raw.runId, queryHash })}`;
    const allowedReasons = new Set<string>(CONTEXT_SELECTION_REASON_ORDER);
    const deliveryItems = items.slice(0, limit).map((item, index) => ({
      entryId: item.entryId,
      entryRevision: item.revision,
      rank: index + 1,
      scoreComponents: {
        status: item.scoreComponents.status,
        trust: item.scoreComponents.trust,
        confidence: item.scoreComponents.confidence,
        retrieval: item.scoreComponents.retrieval,
        taskAffinity: item.scoreComponents.taskAffinity,
        recommendedTags: item.scoreComponents.recommendedTags,
        scopeAffinity: item.scoreComponents.scopeAffinity,
        applicability: item.scoreComponents.applicability,
        pathOverlap: item.scoreComponents.pathOverlap,
        errorSignature: item.scoreComponents.errorSignature,
        exactSignal: item.scoreComponents.exactSignal,
        feedback: item.scoreComponents.feedback,
        recency: 0,
        contradiction: 0,
      },
      selectionReasons: [...new Set([...item.selectionReasons.filter((reason) => allowedReasons.has(reason)), item.scoreComponents.status >= 100 ? 'verified' : 'candidate'])]
        .sort((left, right) => CONTEXT_SELECTION_REASON_ORDER.findIndex((reason) => reason === left) - CONTEXT_SELECTION_REASON_ORDER.findIndex((reason) => reason === right)),
      ...(item.origin === 'project' ? {} : { origin: item.origin }),
    }));
    recordContextDelivery(database, {
      workspace: run.workspace,
      deliveryId,
      runId: raw.runId,
      throughSequence: run.last_sequence,
      intakeSessionId: link.sessionId,
      taskProfileHash,
      queryHash,
      policyVersion: SCOPED_CONTEXT_POLICY_VERSION,
      externalSyncSummary: { attempted: false, imported: 0, sources: [] },
      charBudget: characterBudget,
      charCount: deliveryItems.reduce((total, item) => total + (items.find((candidate) => candidate.entryId === item.entryId)?.bodyPreview.length ?? 0), 0),
      truncated: ordered.length > limit || items.length > limit,
      createdAt: run.created_at,
      scoreSchemaVersion: 2,
      items: deliveryItems,
    });
  }
  return {
    project: project ?? null,
    taskProfileHash,
    queryHash,
    policyVersion: SCOPED_CONTEXT_POLICY_VERSION,
    items: items.slice(0, limit),
    deliveryId,
    truncated: ordered.length > limit || items.length > limit,
    untrusted: true,
  };
}

export function entryOrigin(entry: EntryRecord): FederatedOrigin {
  return entry.workspace === GLOBAL_WORKSPACE ? 'global' : 'project';
}

export function structuredScope(entry: EntryRecord): JsonObject {
  return { ...entry.scope };
}
