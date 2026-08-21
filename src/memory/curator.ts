import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { requireWorkspace, type EntryKind, type JsonObject } from '../serialization/validate.js';
import { recordEntryInTransaction, readEntry, type EntryRecord } from './entries.js';
import {
  buildStructuredScope,
  MEMORY_CLASSES,
  validateApplicability,
  validateSignals,
  type Applicability,
  type MemoryClass,
  type MemorySignals,
} from './structured-memory.js';
import { ensureGlobalWorkspace, GLOBAL_WORKSPACE, resolveProjectWorkspace } from './workspaces.js';
import { readKnowledgeEvidence, type KnowledgeEvidence } from '../akinator/knowledge-path.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const MIN_CURATOR_SCORE = 4;
export const CURATOR_DRAFT_VERSION = 'deterministic-v1' as const;
const GENERIC_LANGUAGE = /(?:汎用|一般化|再利用|共通|手順|パターン|ベストプラクティス|トラブルシューティング|workflow|pattern|best practice|troubleshoot|how[- ]to|reusable|portable|avoid|when to)/iu;
const PROCEDURAL_LANGUAGE = /(?:する|して|確認|切り分け|手順|場合|必要|use|run|check|verify|configure|prefer|avoid|when|if|then|should)/iu;
const LOCAL_LANGUAGE = /(?:この(?:リポジトリ|プロジェクト)|this (?:repository|project)|project-specific|project:|repo_[a-z0-9_]+)/iu;
const ABSOLUTE_PATH = /(?:\/(?:Users|home|private)\/|[A-Za-z]:[\\/])/u;
const ABSOLUTE_PATH_GLOBAL = /(?:\/(?:Users|home|private)\/[^\s`"'<>()[\]{},;!?。！？、]+|[A-Za-z]:[\\/][^\s`"'<>()[\]{},;!?。！？、]+)/gu;
const PROJECT_RELATIVE_PATH = /\b(?:src|tests?|app|lib|packages?|config|resources|migrations)[\\/][A-Za-z0-9_.@/\\-]+\b/gu;
const PROJECT_RELATIVE_PATH_PRESENT = /\b(?:src|tests?|app|lib|packages?|config|resources|migrations)[\\/][A-Za-z0-9_.@/\\-]+\b/u;
const PROJECT_IDENTIFIER = /\b(?:project:[A-Za-z0-9._:-]+|repo_[A-Za-z0-9_-]+)\b/gu;
const PROJECT_PHRASE = /(?:この(?:リポジトリ|プロジェクト)|当(?:リポジトリ|プロジェクト)|本プロジェクト|this (?:repository|project)|the current repository|the current project|project-specific)/giu;
const JAPANESE_TEXT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export type CuratorDraftChange =
  | 'portable-sections-generated'
  | 'project-references-normalized'
  | 'paths-generalized'
  | 'applicability-retained';

export interface CuratorDraft {
  version: typeof CURATOR_DRAFT_VERSION;
  title: string;
  summary: string;
  body: string;
  changes: CuratorDraftChange[];
}

export interface CuratorCandidate {
  entryId: string;
  workspace: string;
  revision: number;
  kind: EntryKind;
  skillName: string;
  overview: [string, string, string];
  draft: CuratorDraft;
  score: number;
  reasons: string[];
  warnings: string[];
  knowledge: KnowledgeEvidence & {
    skillReady: boolean;
    readinessReasons: string[];
  };
}

export interface CuratorCandidatesInput {
  workspace?: string;
  cwd?: string;
  limit?: number;
  skillReadyOnly?: boolean;
}

export interface CuratorCandidatesResult {
  workspace: string | null;
  candidates: CuratorCandidate[];
  count: number;
  truncated: boolean;
  securityNotice: string;
}

export interface GlobalizeCuratorInput {
  workspace: string;
  entryId: string;
  expectedRevision: number;
  actor?: string;
  now?: string;
}

export interface GlobalizeCuratorResult {
  candidate: CuratorCandidate;
  global: EntryRecord;
  idempotent: boolean;
}

interface StructuredMetadata {
  memoryClass?: MemoryClass;
  applicability?: Applicability;
  signals?: MemorySignals;
}

interface CuratorScore {
  score: number;
  reasons: string[];
  warnings: string[];
  metadata: StructuredMetadata;
}

function hasValues(value: object | undefined): boolean {
  return value !== undefined && Object.values(value).some((item) => Array.isArray(item) && item.length > 0);
}

function readStructuredMetadata(entry: EntryRecord): StructuredMetadata {
  const raw = entry.scope as Record<string, unknown>;
  const metadata: StructuredMetadata = {};
  if (typeof raw.memoryClass === 'string' && MEMORY_CLASSES.includes(raw.memoryClass as MemoryClass)) {
    metadata.memoryClass = raw.memoryClass as MemoryClass;
  }
  if (raw.applicability !== undefined) {
    try {
      metadata.applicability = validateApplicability(raw.applicability);
    } catch {
      // Legacy entries may contain arbitrary scope JSON. Curator ignores invalid metadata.
    }
  }
  if (raw.signals !== undefined) {
    try {
      metadata.signals = validateSignals(raw.signals);
    } catch {
      // Legacy entries may contain arbitrary scope JSON. Curator ignores invalid metadata.
    }
  }
  return metadata;
}

function sourceText(entry: EntryRecord): string {
  return [entry.title, entry.summary ?? '', entry.body].join('\n').trim();
}

function compactLine(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, 240);
}

function applicabilityLine(applicability: Applicability | undefined, japanese = true): string {
  if (applicability === undefined || !hasValues(applicability)) {
    return japanese ? '明示的な適用条件なし（Global化前に確認）' : 'No explicit applicability metadata; review before globalization.';
  }
  const values: string[] = [];
  if (applicability.languages?.length) values.push(`${japanese ? '言語' : 'Languages'}: ${applicability.languages.join(', ')}`);
  if (applicability.frameworks?.length) values.push(`Framework: ${applicability.frameworks.map((item) => item.version ? `${item.name} ${item.version}` : item.name).join(', ')}`);
  if (applicability.databases?.length) values.push(`DB: ${applicability.databases.join(', ')}`);
  if (applicability.runtimes?.length) values.push(`Runtime: ${applicability.runtimes.join(', ')}`);
  if (applicability.tools?.length) values.push(`Tool: ${applicability.tools.join(', ')}`);
  if (applicability.platforms?.length) values.push(`Platform: ${applicability.platforms.join(', ')}`);
  return values.join(' / ');
}

function knownProjectValues(entry: EntryRecord): string[] {
  const rawScope = entry.scope as Record<string, unknown>;
  const rawProvenance = entry.provenance as Record<string, unknown>;
  const values = [entry.workspace, rawScope.repositoryId, rawProvenance.sourceWorkspace, rawProvenance.sourceRepositoryId];
  const sourcePaths = rawProvenance.sourcePaths;
  if (Array.isArray(sourcePaths)) values.push(...sourcePaths);
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length >= 3))]
    .sort((left, right) => right.length - left.length);
}

function containsProjectSpecificData(value: string, entry: EntryRecord): boolean {
  const normalized = value.normalize('NFKC');
  return knownProjectValues(entry).some((known) => normalized.includes(known.normalize('NFKC')))
    || LOCAL_LANGUAGE.test(normalized)
    || ABSOLUTE_PATH.test(normalized)
    || PROJECT_RELATIVE_PATH_PRESENT.test(normalized);
}

function portableText(value: string, entry: EntryRecord, title = false): string {
  const japanese = JAPANESE_TEXT.test(value);
  const projectReplacement = japanese ? '対象プロジェクト' : 'the target project';
  const pathReplacement = japanese ? '対象ファイル' : 'the relevant project file';
  let result = value.normalize('NFKC');
  for (const known of knownProjectValues(entry)) result = result.replaceAll(known.normalize('NFKC'), known.includes('/') || known.includes('\\') ? pathReplacement : projectReplacement);
  result = result
    .replace(PROJECT_PHRASE, projectReplacement)
    .replace(ABSOLUTE_PATH_GLOBAL, pathReplacement)
    .replace(PROJECT_RELATIVE_PATH, pathReplacement)
    .replace(PROJECT_IDENTIFIER, projectReplacement)
    .replace(/(?:the target project)(?:\s+the target project)+/giu, 'the target project')
    .replace(/(?:対象プロジェクト)(?:\s*対象プロジェクト)+/gu, '対象プロジェクト')
    .replace(/(?:the relevant project file)(?:\s+the relevant project file)+/giu, 'the relevant project file')
    .replace(/(?:対象ファイル)(?:\s*対象ファイル)+/gu, '対象ファイル');
  result = result.split(/\r?\n/u).map((line) => line.replace(/[\t ]+/gu, ' ').trim()).filter(Boolean).join('\n');
  if (title) {
    result = result
      .replace(/^(?:the target project|対象プロジェクト)\s*(?:only\s*)?[-:：]?\s*/iu, '')
      .replace(/^(?:only\s+)?(?:decision|knowledge)\s*[-:：]\s*/iu, '');
  }
  return result.trim();
}

function statements(value: string): string[] {
  return value
    .split(/\r?\n+/u)
    .flatMap((line) => line.split(/(?<=[.!?。！？])\s+/u))
    .map((line) => compactLine(line.replace(/^\s*(?:[-*]|\d+[.)])\s*/u, '')))
    .filter(Boolean);
}

export function regenerateCuratorDraft(entry: EntryRecord, metadata = readStructuredMetadata(entry)): CuratorDraft {
  const source = sourceText(entry);
  const japanese = JAPANESE_TEXT.test(source);
  const portableTitle = portableText(entry.title, entry, true);
  const sourceSummary = entry.summary?.trim() || statements(entry.body)[0] || entry.title;
  const summary = compactLine(portableText(sourceSummary, entry)) || (japanese ? '再利用可能な知識' : 'Reusable knowledge');
  const procedure = [...new Set(statements(portableText(entry.body, entry)).filter((line) => line !== summary))].slice(0, 6);
  if (procedure.length === 0) procedure.push(summary);
  const applicability = applicabilityLine(metadata.applicability, japanese);
  const body = japanese
    ? [
        '目的', summary,
        '', '手順', ...procedure.map((line, index) => `${index + 1}. ${line}`),
        '', '適用条件', applicability,
        '', '検証', '対象プロジェクトの現在の状態で結果を確認してから、検証済みの知識として利用する。',
      ].join('\n')
    : [
        'Purpose', summary,
        '', 'Procedure', ...procedure.map((line, index) => `${index + 1}. ${line}`),
        '', 'Applicability', applicability,
        '', 'Verification', 'Confirm the result against the target project\'s current state before treating this knowledge as verified.',
      ].join('\n');
  const changes: CuratorDraftChange[] = ['portable-sections-generated'];
  const normalizedBody = portableText(entry.body, entry);
  if (portableTitle !== entry.title || normalizedBody !== entry.body.trim()) changes.push('project-references-normalized');
  const sourcePaths = (entry.provenance as Record<string, unknown>).sourcePaths;
  if (ABSOLUTE_PATH.test(source) || PROJECT_RELATIVE_PATH_PRESENT.test(source) || (Array.isArray(sourcePaths) && sourcePaths.length > 0)) changes.push('paths-generalized');
  if (hasValues(metadata.applicability)) changes.push('applicability-retained');
  return {
    version: CURATOR_DRAFT_VERSION,
    title: compactLine(portableTitle) || (japanese ? '再利用可能な知識' : 'Reusable knowledge'),
    summary,
    body,
    changes,
  };
}

function overviewLines(draft: CuratorDraft, metadata: StructuredMetadata): [string, string, string] {
  const procedure = draft.body.split(/\r?\n/u).map(compactLine).find((line) => /^1\.\s/u.test(line))?.replace(/^1\.\s*/u, '')
    ?? (JAPANESE_TEXT.test(draft.body) ? '再生成された本文を確認してください' : 'Review the regenerated body.');
  const japanese = JAPANESE_TEXT.test(draft.body);
  return [draft.summary, procedure, `${japanese ? '適用条件' : 'Applicability'}: ${applicabilityLine(metadata.applicability, japanese)}`];
}

function scoreEntry(entry: EntryRecord): CuratorScore {
  const metadata = readStructuredMetadata(entry);
  const text = sourceText(entry);
  let score = 0;
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (entry.kind === 'lesson' || entry.kind === 'decision' || entry.kind === 'reference') {
    score += 2;
    reasons.push('再利用しやすい記憶タイプ');
  } else if (entry.kind === 'fact') {
    score += 1;
    reasons.push('事実として保存された候補');
  } else {
    score -= 1;
    warnings.push('preferenceはプロジェクト依存の可能性があります');
  }
  if (metadata.memoryClass !== undefined && metadata.memoryClass !== 'preference') {
    score += 2;
    reasons.push(`memoryClass=${metadata.memoryClass}`);
  }
  if (hasValues(metadata.applicability)) {
    score += 2;
    reasons.push('適用条件が構造化されています');
  }
  if (entry.tags.some((tag) => /^(?:skill:|bot:common$|workflow$|pattern$|reusable$|global$)/iu.test(tag))) {
    score += 2;
    reasons.push('汎用化を示すタグがあります');
  }
  if (GENERIC_LANGUAGE.test(text)) {
    score += 2;
    reasons.push('汎用的・再利用可能な表現があります');
  }
  if (PROCEDURAL_LANGUAGE.test(text)) {
    score += 1;
    reasons.push('手順・判断基準として読めます');
  }
  if (text.length >= 80) {
    score += 1;
    reasons.push('説明が十分な長さです');
  }
  if (LOCAL_LANGUAGE.test(text)) {
    score -= 3;
    warnings.push('プロジェクト固有の表現があります');
  }
  if (ABSOLUTE_PATH.test(text)) {
    score -= 3;
    warnings.push('絶対パスが含まれています');
  }
  const sourcePaths = (entry.provenance.sourcePaths as unknown);
  if (Array.isArray(sourcePaths) && sourcePaths.length > 0) {
    score -= 1;
    warnings.push('元プロジェクトのパス由来です');
  }
  return { score, reasons: [...new Set(reasons)], warnings: [...new Set(warnings)], metadata };
}

function candidateFromEntry(database: SqliteDatabase, entry: EntryRecord): CuratorCandidate | null {
  if (entry.workspace === GLOBAL_WORKSPACE || entry.status !== 'candidate') return null;
  const scored = scoreEntry(entry);
  const evidence = readKnowledgeEvidence(database, entry);
  const portableEvidence = evidence.independentWorkspaces >= 2 || hasValues(scored.metadata.applicability);
  const readinessReasons = [
    ...(evidence.independentRuns >= 2 ? ['独立したrunで2回以上成功'] : ['独立した成功runが2回未満']),
    ...(evidence.averageCompleteness >= 0.9 ? ['抽象→具体サイロが十分に充足'] : ['抽象→具体サイロの充足証拠が不足']),
    ...(portableEvidence ? ['複数workspaceまたは明示的な適用条件あり'] : ['プロジェクト外への適用根拠が不足']),
  ];
  const skillReady = evidence.qualifiedHits >= 2
    && evidence.independentRuns >= 2
    && evidence.averageCompleteness >= 0.9
    && portableEvidence;
  if (evidence.qualifiedHits > 0) {
    scored.score += Math.min(4, evidence.qualifiedHits * 2);
    scored.reasons.push(`検証済み推論経路 ${evidence.qualifiedHits}件`);
  } else {
    scored.warnings.push('検証済みのAkinator推論経路はまだありません');
  }
  if (scored.score < MIN_CURATOR_SCORE) return null;
  const draft = regenerateCuratorDraft(entry, scored.metadata);
  return {
    entryId: entry.id,
    workspace: entry.workspace,
    revision: entry.revision,
    kind: entry.kind,
    skillName: draft.title,
    overview: overviewLines(draft, scored.metadata),
    draft,
    score: scored.score,
    reasons: scored.reasons,
    warnings: scored.warnings,
    knowledge: { ...evidence, skillReady, readinessReasons },
  };
}

function validateLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new KiokukoError('VALIDATION_ERROR', `limit must be an integer between 1 and ${MAX_LIMIT}`);
  return limit;
}

function listCuratorCandidates(database: SqliteDatabase, workspace: string, limit: number, skillReadyOnly: boolean): { candidates: CuratorCandidate[]; truncated: boolean } {
  if (workspace === GLOBAL_WORKSPACE) return { candidates: [], truncated: false };
  const rows = database.prepare(`
    SELECT id
      FROM entries
     WHERE workspace = ? AND status = 'candidate'
     ORDER BY updated_at DESC, id ASC
     LIMIT ?
  `).all<{ id: string }>(workspace, (MAX_LIMIT * 10) + 1);
  const candidates = rows
    .map((row) => {
      const entry = readEntry(database, { workspace, entryId: row.id });
      const candidate = candidateFromEntry(database, entry);
      if (candidate !== null && existingGlobalEntry(database, curatedReference(entry)) !== undefined) return null;
      return candidate;
    })
    .filter((candidate): candidate is CuratorCandidate => candidate !== null)
    .filter((candidate) => !skillReadyOnly || candidate.knowledge.skillReady)
    .sort((left, right) => Number(right.knowledge.skillReady) - Number(left.knowledge.skillReady) || right.score - left.score || left.entryId.localeCompare(right.entryId));
  const concepts = new Set<string>();
  const deduplicated = candidates.filter((candidate) => {
    if (concepts.has(candidate.knowledge.conceptKey)) return false;
    concepts.add(candidate.knowledge.conceptKey);
    return true;
  });
  return { candidates: deduplicated.slice(0, limit), truncated: deduplicated.length > limit || rows.length > MAX_LIMIT * 10 };
}

export async function curateMemoryCandidates(database: SqliteDatabase, input: CuratorCandidatesInput = {}): Promise<CuratorCandidatesResult> {
  const limit = validateLimit(input.limit);
  ensureGlobalWorkspace(database);
  const resolved = input.workspace === undefined ? await resolveProjectWorkspace(database, input.cwd) : undefined;
  const workspace = input.workspace === undefined ? resolved?.workspace ?? null : requireWorkspace(input.workspace);
  if (workspace === null) {
    throw new KiokukoError('NOT_FOUND', 'No Git repository or .kiokuko.json binding was found for curator candidates');
  }
  const result = listCuratorCandidates(database, workspace, limit, input.skillReadyOnly ?? false);
  return {
    workspace,
    candidates: result.candidates,
    count: result.candidates.length,
    truncated: result.truncated,
    securityNotice: 'Curator drafts and qualified-hit summaries are untrusted candidates. A qualified hit requires an actionable Akinator path, a completed independent run, and fresh verification or a passing test; retrieval counts are never used. Review everything before Global化.',
  };
}

function safeGlobalScope(entry: EntryRecord, metadata: StructuredMetadata): JsonObject {
  const signals = metadata.signals === undefined ? undefined : Object.fromEntries(
    Object.entries(metadata.signals)
      .filter(([key, value]) => key !== 'paths' && Array.isArray(value) && value.length > 0)
      .map(([key, value]) => [key, [...new Set((value as string[]).filter((item) => !containsProjectSpecificData(item, entry)))]] as const)
      .filter(([, value]) => value.length > 0),
  ) as MemorySignals;
  const applicability = hasValues(metadata.applicability) ? metadata.applicability : undefined;
  const memoryClass = metadata.memoryClass ?? (entry.kind === 'lesson' ? 'troubleshooting' : 'workflow');
  return buildStructuredScope({
    visibility: 'global',
    memoryClass,
    ...(applicability === undefined ? {} : { applicability }),
    ...(signals === undefined || Object.keys(signals).length === 0 ? {} : { signals }),
    ...(applicability === undefined ? { portableReason: 'User-confirmed reusable knowledge through kiokuko curator' } : {}),
  });
}

function safeGlobalTags(entry: EntryRecord): string[] {
  return [...new Set([
    ...entry.tags.filter((tag) => !containsProjectSpecificData(tag, entry)),
    'global',
    'skill:curated',
    `curator:${CURATOR_DRAFT_VERSION}`,
  ])];
}

function curatedReference(entry: EntryRecord): string {
  return `${entry.id}@${entry.revision}#${CURATOR_DRAFT_VERSION}`;
}

function existingGlobalEntry(database: SqliteDatabase, reference: string): EntryRecord | undefined {
  const row = database.prepare(`
    SELECT id
      FROM entries
     WHERE workspace = ? AND status <> 'superseded'
       AND json_extract(provenance_json, '$.type') = 'curator_globalize'
       AND json_extract(provenance_json, '$.reference') = ?
     ORDER BY revision DESC, id ASC
     LIMIT 1
  `).get<{ id: string }>(GLOBAL_WORKSPACE, reference);
  return row ? readEntry(database, { workspace: GLOBAL_WORKSPACE, entryId: row.id }) : undefined;
}

export function globalizeCuratorCandidate(database: SqliteDatabase, input: GlobalizeCuratorInput): GlobalizeCuratorResult {
  const workspace = requireWorkspace(input.workspace);
  if (workspace === GLOBAL_WORKSPACE) throw new KiokukoError('VALIDATION_ERROR', 'Curator source workspace must be a project workspace');
  if (typeof input.entryId !== 'string' || input.entryId.length === 0) throw new KiokukoError('VALIDATION_ERROR', 'entryId must be a non-empty string');
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new KiokukoError('VALIDATION_ERROR', 'expectedRevision must be a positive integer');
  const actor = input.actor ?? 'kiokuko-curator';
  const now = input.now ?? new Date().toISOString();

  return withImmediateTransaction(database, () => {
    const source = readEntry(database, { workspace, entryId: input.entryId });
    if (source.status !== 'candidate') throw new KiokukoError('CONFLICT', 'Only candidate entries can be Global化候補になります');
    if (source.revision !== input.expectedRevision) throw new KiokukoError('CONFLICT', 'Entry revision is stale');
    const candidate = candidateFromEntry(database, source);
    if (candidate === null) throw new KiokukoError('CONFLICT', 'This entry is not recommended for Global化 by curator');
    const reference = curatedReference(source);
    const existing = existingGlobalEntry(database, reference);
    if (existing) return { candidate, global: existing, idempotent: true };
    const metadata = scoreEntry(source).metadata;
    const sourceProvenance = source.provenance as Record<string, unknown>;
    const provenance = {
      type: 'curator_globalize',
      reference,
      sourceWorkspace: source.workspace,
      ...(typeof sourceProvenance.sourceRepositoryId === 'string' ? { sourceRepositoryId: sourceProvenance.sourceRepositoryId } : {}),
      ...(typeof sourceProvenance.sourceCommit === 'string' ? { sourceCommit: sourceProvenance.sourceCommit } : {}),
      clientKind: actor,
      timestamp: now,
    };
    const global = recordEntryInTransaction(database, {
      workspace: GLOBAL_WORKSPACE,
      kind: source.kind,
      status: 'candidate',
      title: candidate.draft.title,
      body: candidate.draft.body,
      summary: candidate.draft.summary,
      scope: safeGlobalScope(source, metadata),
      provenance,
      trustLevel: 'untrusted',
      confidence: Math.min(source.confidence, 0.8),
      tags: safeGlobalTags(source),
      createdBy: actor,
      actor,
    });
    return { candidate, global, idempotent: false };
  });
}

export function formatCuratorCandidate(candidate: CuratorCandidate): string {
  return [
    `スキル名: ${candidate.skillName}`,
    `エントリ: ${candidate.entryId} / revision ${candidate.revision}`,
    '概要:',
    ...candidate.overview.map((line) => `  ${line}`),
    '再生成ドラフト:',
    `  タイトル: ${candidate.draft.title}`,
    `  要約: ${candidate.draft.summary}`,
    '  本文:',
    ...candidate.draft.body.split('\n').map((line) => `    ${line}`),
    `  生成方式: ${candidate.draft.version}`,
    `  変更: ${candidate.draft.changes.join(', ')}`,
    `判定スコア: ${candidate.score}`,
    `永続知識判定: ${candidate.knowledge.skillReady ? 'skill-ready' : candidate.knowledge.tier}`,
    `qualified hit: ${candidate.knowledge.qualifiedHits} / 独立run: ${candidate.knowledge.independentRuns} / workspace: ${candidate.knowledge.independentWorkspaces}`,
    `サイロ充足度: ${candidate.knowledge.averageCompleteness}`,
    `判定根拠: ${candidate.knowledge.readinessReasons.join('、')}`,
    ...(candidate.reasons.length === 0 ? [] : [`理由: ${candidate.reasons.join('、')}`]),
    ...(candidate.warnings.length === 0 ? [] : [`注意: ${candidate.warnings.join('、')}`]),
  ].join('\n');
}

export function curatorCandidateForEntry(database: SqliteDatabase, input: { workspace: string; entryId: string }): CuratorCandidate {
  const entry = readEntry(database, { workspace: input.workspace, entryId: input.entryId });
  const candidate = candidateFromEntry(database, entry);
  if (candidate === null) throw new KiokukoError('CONFLICT', 'Entry is not a curator candidate');
  return candidate;
}
