import type { SqliteDatabase } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { recordEntryInTransaction } from '../memory/entries.js';
import { canonicalContentHash, type JsonObject } from '../serialization/validate.js';
import type { TaskProfile } from '../akinator/types.js';

export type FetchImpl = typeof fetch;

export interface OfficialSource {
  id: string;
  name: string;
  owner: string;
  repository: string;
  ref: string;
  roots: string[];
  repositoryUrl: string;
}

export const OFFICIAL_SOURCES: OfficialSource[] = [
  {
    id: 'mattpocock-skills',
    name: 'Matt Pocock Skills',
    owner: 'mattpocock',
    repository: 'skills',
    ref: 'main',
    roots: ['skills'],
    repositoryUrl: 'https://github.com/mattpocock/skills',
  },
];

interface TreeItem {
  path: string;
  type: string;
}

export interface PreparedOfficialSourceDocument {
  sourceId: string;
  commit: string;
  path: string;
  content: string;
  title: string;
  summary: string | null;
  score: number;
  tags: string[];
}

export interface PreparedOfficialSource {
  sourceId: string;
  commit: string | null;
  documents: PreparedOfficialSourceDocument[];
  error?: string;
}

export interface PreparedOfficialSourceSync {
  attempted: true;
  sources: PreparedOfficialSource[];
}

export interface SourceSyncInput {
  database: SqliteDatabase;
  workspace: string;
  task: string;
  profile: TaskProfile;
  recommendedTags: string[];
  fetchImpl?: FetchImpl;
  now?: string;
}

export type PrepareOfficialSourceSyncInput = Omit<SourceSyncInput, 'database' | 'now'>;

export interface SourceSyncResult {
  attempted: true;
  imported: number;
  sources: Array<{
    sourceId: string;
    commit: string | null;
    documents: number;
    imported: number;
    error?: string;
  }>;
}

const MAX_TREE_ITEMS = 500;
const MAX_DOCUMENTS_PER_SOURCE = 8;
const MAX_DOCUMENT_BYTES = 100_000;
const MAX_SUMMARY_CHARACTERS = 500;
const MAX_TITLE_CHARACTERS = 2_000;
const MAX_COMMIT_CHARACTERS = 200;
const MAX_SOURCE_ERROR_CHARACTERS = 160;
const MAX_SOURCE_ID_CHARACTERS = 100;
const MAX_TASK_CHARACTERS = 16_384;
const ALLOWED_REVISION = /^[A-Za-z0-9._-]{1,200}$/u;
const ALLOWED_PATH = /^[A-Za-z0-9._/-]{1,2000}$/u;

function sourceApiUrl(source: OfficialSource, endpoint: string): string {
  return `https://api.github.com/repos/${source.owner}/${source.repository}/${endpoint}`;
}

function rawDocumentUrl(source: OfficialSource, commit: string, path: string): string {
  return `https://raw.githubusercontent.com/${source.owner}/${source.repository}/${commit}/${path}`;
}

function sourceForId(sourceId: string): OfficialSource {
  const source = OFFICIAL_SOURCES.find((candidate) => candidate.id === sourceId);
  if (!source) throw new KiokukoError('VALIDATION_ERROR', 'Official source is not allowlisted');
  return source;
}

function sourceFailure(): KiokukoError {
  return new KiokukoError('PARTIAL_FAILURE', 'Official source could not be prepared');
}

function safeError(error: unknown): string {
  if (error instanceof KiokukoError && error.code === 'SECURITY_REJECTION') return 'document_rejected';
  if (error instanceof KiokukoError && error.code === 'PARTIAL_FAILURE') return 'source_unavailable';
  return 'source_unavailable';
}

async function fetchBoundedText(fetchImpl: FetchImpl, url: string, accept: string): Promise<string> {
  const response = await fetchImpl(url, {
    headers: {
      accept,
      'user-agent': 'kiokuko-source-sync',
    },
  });
  if (!response.ok) throw sourceFailure();
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 2_000_000) throw sourceFailure();
    return text;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      size += chunk.byteLength;
      if (size > 2_000_000) {
        await reader.cancel();
        throw sourceFailure();
      }
      chunks.push(chunk);
    }
  } catch {
    throw sourceFailure();
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchJson(fetchImpl: FetchImpl, url: string): Promise<unknown> {
  const text = await fetchBoundedText(fetchImpl, url, 'application/vnd.github+json');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw sourceFailure();
  }
}

async function fetchText(fetchImpl: FetchImpl, url: string): Promise<string> {
  const text = await fetchBoundedText(fetchImpl, url, 'text/plain');
  if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) throw sourceFailure();
  return text;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw sourceFailure();
  return value as Record<string, unknown>;
}

function revision(value: unknown): string {
  if (typeof value !== 'string' || !ALLOWED_REVISION.test(value)) throw sourceFailure();
  return value;
}

function parseFrontmatter(content: string): { name: string | null; description: string | null; disableModelInvocation: boolean } {
  const metadata = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.[1] ?? '';
  const name = /^name:\s*["']?(.+?)["']?\s*$/mu.exec(metadata)?.[1]?.trim() ?? null;
  const description = /^description:\s*["']?(.+?)["']?\s*$/mu.exec(metadata)?.[1]?.trim() ?? null;
  return {
    name: name?.slice(0, MAX_TITLE_CHARACTERS) || null,
    description: description?.slice(0, MAX_SUMMARY_CHARACTERS) || null,
    disableModelInvocation: /^disable-model-invocation:\s*true\s*$/mu.test(metadata),
  };
}

function tokens(value: string): Set<string> {
  return new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu) ?? []).filter((token) => token.length > 1));
}

function pathRoleTags(path: string): string[] {
  const normalized = path.toLocaleLowerCase();
  const tags = new Set<string>();
  if (/tdd|prototype|implement|codebase-design/u.test(normalized)) tags.add('bot:builder');
  if (/diagnos|debug|code-review|resolving-merge-conflicts/u.test(normalized)) tags.add('bot:reviewer');
  if (/research|citation|search/u.test(normalized)) tags.add('bot:researcher');
  if (/wizard|devops|infrastructure|deploy/u.test(normalized)) tags.add('bot:devops');
  if (/writing|document|to-spec|to-prd/u.test(normalized)) tags.add('bot:writer');
  if (/analysis|domain-modeling|codebase-design/u.test(normalized)) tags.add('bot:analyst');
  return [...tags].sort();
}

function scoreDocument(document: { path: string; title: string; summary: string | null; content: string }, task: string, profile: TaskProfile, recommendedTags: string[]): number {
  const query = tokens([task, profile.target ?? '', profile.expected ?? '', profile.constraints ?? ''].join(' '));
  const searchable = tokens([document.path, document.title, document.summary ?? '', document.content.slice(0, 12_000)].join(' '));
  let score = [...query].filter((token) => searchable.has(token)).length;
  const normalizedPath = document.path.toLocaleLowerCase();
  if (profile.taskType === 'build' && /tdd|test|implement|develop|codebase-design/u.test(normalizedPath)) score += 5;
  if (profile.taskType === 'debug' && /debug|diagnos|systematic/u.test(normalizedPath)) score += 5;
  if (profile.taskType === 'research' && /research|citation|search/u.test(normalizedPath)) score += 5;
  if (profile.taskType === 'review' && /review|verification/u.test(normalizedPath)) score += 5;
  if (profile.taskType === 'devops' && /devops|infra|docker|server/u.test(normalizedPath)) score += 5;
  if (profile.taskType === 'writing' && /writing|document/u.test(normalizedPath)) score += 5;
  if (recommendedTags.some((tag) => pathRoleTags(document.path).includes(tag))) score += 3;
  return score;
}

function documentTitle(source: OfficialSource, path: string, content: string): { title: string; summary: string | null } {
  const frontmatter = parseFrontmatter(content);
  const basename = path.split('/').at(-2) ?? path.split('/').at(-1) ?? 'document';
  return {
    title: `${source.name}: ${frontmatter.name ?? basename}`.slice(0, MAX_TITLE_CHARACTERS),
    summary: frontmatter.description
      ?? content.replace(/^---[\s\S]*?---\s*/u, '').trim().slice(0, MAX_SUMMARY_CHARACTERS),
  };
}

function isCandidatePath(source: OfficialSource, path: string): boolean {
  if (!ALLOWED_PATH.test(path) || !path.endsWith('/SKILL.md')) return false;
  return source.roots.some((root) => path === root || path.startsWith(`${root}/`));
}

async function loadSourceDocuments(source: OfficialSource, fetchImpl: FetchImpl, task: string, profile: TaskProfile, recommendedTags: string[]): Promise<{ commit: string; documents: PreparedOfficialSourceDocument[] }> {
  const commitValue = revision(asObject(await fetchJson(fetchImpl, sourceApiUrl(source, `commits/${source.ref}`))).sha);
  const treeValue = asObject(await fetchJson(fetchImpl, sourceApiUrl(source, `git/trees/${commitValue}?recursive=1`)));
  if (treeValue.truncated === true || !Array.isArray(treeValue.tree)) throw sourceFailure();
  const tree = (treeValue.tree as unknown[]).flatMap((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
    const object = item as Record<string, unknown>;
    return typeof object.path === 'string' && typeof object.type === 'string' ? [{ path: object.path, type: object.type }] : [];
  }) as TreeItem[];
  const paths = tree
    .filter((item) => item.type === 'blob' && isCandidatePath(source, item.path))
    .sort((left, right) => left.path.localeCompare(right.path))
    .slice(0, MAX_TREE_ITEMS);
  const documents: PreparedOfficialSourceDocument[] = [];
  for (const item of paths) {
    const content = await fetchText(fetchImpl, rawDocumentUrl(source, commitValue, item.path));
    if (parseFrontmatter(content).disableModelInvocation) continue;
    const title = documentTitle(source, item.path, content);
    const score = scoreDocument({ path: item.path, ...title, content }, task, profile, recommendedTags);
    if (score > 0) documents.push({
      sourceId: source.id,
      commit: commitValue,
      path: item.path,
      content,
      ...title,
      score,
      tags: pathRoleTags(item.path),
    });
  }
  documents.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return { commit: commitValue, documents: documents.slice(0, MAX_DOCUMENTS_PER_SOURCE) };
}

function clonePrepared(prepared: PreparedOfficialSourceSync): PreparedOfficialSourceSync {
  const copy = structuredClone(prepared);
  return deepFreeze(copy);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export async function prepareOfficialSourceSync(input: PrepareOfficialSourceSyncInput): Promise<PreparedOfficialSourceSync> {
  if (typeof input.workspace !== 'string' || input.workspace.length === 0) throw new KiokukoError('VALIDATION_ERROR', 'Official source preparation input is invalid');
  if (typeof input.task !== 'string' || input.task.length > MAX_TASK_CHARACTERS) throw new KiokukoError('VALIDATION_ERROR', 'Official source preparation input is invalid');
  const fetchImpl = input.fetchImpl ?? fetch;
  const sources = await Promise.all(OFFICIAL_SOURCES.map(async (source): Promise<PreparedOfficialSource> => {
    try {
      const loaded = await loadSourceDocuments(source, fetchImpl, input.task, input.profile, input.recommendedTags);
      return { sourceId: source.id, commit: loaded.commit, documents: loaded.documents };
    } catch (error) {
      return { sourceId: source.id, commit: null, documents: [], error: safeError(error).slice(0, MAX_SOURCE_ERROR_CHARACTERS) };
    }
  }));
  return clonePrepared({ attempted: true, sources });
}

function validatePrepared(prepared: unknown): PreparedOfficialSourceSync {
  if (typeof prepared !== 'object' || prepared === null || Array.isArray(prepared)) throw new KiokukoError('VALIDATION_ERROR', 'Prepared official source data is invalid');
  const input = prepared as Record<string, unknown>;
  if (input.attempted !== true || !Array.isArray(input.sources) || input.sources.length !== OFFICIAL_SOURCES.length) throw new KiokukoError('VALIDATION_ERROR', 'Prepared official source data is invalid');
  const sources: PreparedOfficialSource[] = [];
  const seenSources = new Set<string>();
  for (const value of input.sources) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KiokukoError('VALIDATION_ERROR', 'Prepared official source data is invalid');
    const source = value as Record<string, unknown>;
    if (typeof source.sourceId !== 'string' || source.sourceId.length > MAX_SOURCE_ID_CHARACTERS || seenSources.has(source.sourceId)) throw new KiokukoError('VALIDATION_ERROR', 'Prepared official source data is invalid');
    const official = sourceForId(source.sourceId);
    seenSources.add(source.sourceId);
    const commitValue = source.commit;
    const commit = commitValue === null ? null : revision(commitValue);
    if (!Array.isArray(source.documents) || source.documents.length > MAX_DOCUMENTS_PER_SOURCE) throw new KiokukoError('VALIDATION_ERROR', 'Prepared official source data is invalid');
    const paths = new Set<string>();
    const documents = source.documents.map((value): PreparedOfficialSourceDocument => {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KiokukoError('VALIDATION_ERROR', 'Prepared official source data is invalid');
      const document = value as Record<string, unknown>;
      if (document.sourceId !== official.id || typeof document.commit !== 'string' || document.commit !== commit || !ALLOWED_REVISION.test(document.commit)) throw new KiokukoError('VALIDATION_ERROR', 'Prepared official source data is invalid');
      if (typeof document.path !== 'string' || !isCandidatePath(official, document.path) || paths.has(document.path)) throw new KiokukoError('VALIDATION_ERROR', 'Prepared official source data is invalid');
      paths.add(document.path);
      if (typeof document.content !== 'string' || Buffer.byteLength(document.content, 'utf8') > MAX_DOCUMENT_BYTES) throw new KiokukoError('VALIDATION_ERROR', 'Prepared official source data is invalid');
      if (typeof document.title !== 'string' || document.title.length === 0 || document.title.length > MAX_TITLE_CHARACTERS) throw new KiokukoError('VALIDATION_ERROR', 'Prepared official source data is invalid');
      if (document.summary !== null && (typeof document.summary !== 'string' || document.summary.length > MAX_SUMMARY_CHARACTERS)) throw new KiokukoError('VALIDATION_ERROR', 'Prepared official source data is invalid');
      if (typeof document.score !== 'number' || !Number.isSafeInteger(document.score) || document.score < 1) throw new KiokukoError('VALIDATION_ERROR', 'Prepared official source data is invalid');
      if (!Array.isArray(document.tags) || document.tags.length > 16 || document.tags.some((tag) => typeof tag !== 'string' || tag.length === 0 || tag.length > 200)) throw new KiokukoError('VALIDATION_ERROR', 'Prepared official source data is invalid');
      return {
        sourceId: official.id,
        commit: document.commit,
        path: document.path,
        content: document.content,
        title: document.title,
        summary: document.summary as string | null,
        score: document.score,
        tags: [...new Set(document.tags as string[])].sort(),
      };
    }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
    const safeSourceError = source.error === undefined
      ? undefined
      : source.error === 'source_unavailable' || source.error === 'document_rejected'
        ? source.error
        : 'source_unavailable';
    sources.push({ sourceId: official.id, commit, documents, ...(safeSourceError === undefined ? {} : { error: safeSourceError.slice(0, MAX_SOURCE_ERROR_CHARACTERS) }) });
  }
  if (seenSources.size !== OFFICIAL_SOURCES.length) throw new KiokukoError('VALIDATION_ERROR', 'Prepared official source data is invalid');
  return { attempted: true, sources: sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId)) };
}

function documentInput(workspace: string, document: PreparedOfficialSourceDocument): {
  input: Parameters<typeof recordEntryInTransaction>[1];
  contentHash: string;
} {
  const source = sourceForId(document.sourceId);
  const provenance = {
    type: 'github_repository',
    reference: `https://github.com/${source.owner}/${source.repository}/blob/${document.commit}/${document.path}`,
  } as JsonObject;
  const tags = [...new Set([
    `source:${source.id}`,
    document.path.endsWith('/SKILL.md') ? 'external:skill' : 'external:knowledge',
    `skill:${document.path.split('/').at(-2) ?? 'document'}`,
    ...document.tags,
  ])].sort();
  const input = {
    workspace,
    kind: 'reference' as const,
    title: document.title,
    body: document.content,
    summary: document.summary,
    provenance,
    trustLevel: 'untrusted' as const,
    confidence: 0.75,
    tags,
    createdBy: 'kiokuko-source-sync',
    actor: 'kiokuko-source-sync',
  };
  return { input, contentHash: canonicalContentHash({ kind: input.kind, title: input.title, body: input.body, summary: input.summary, scope: {}, provenance, tags }) };
}

export interface PersistOfficialSourceSyncInput {
  workspace: string;
  prepared: PreparedOfficialSourceSync;
  now?: string;
}

export function persistOfficialSourceSyncInTransaction(database: SqliteDatabase, input: { workspace: string; prepared: PreparedOfficialSourceSync; now?: string }): SourceSyncResult {
  const workspace = input.workspace;
  if (typeof workspace !== 'string' || workspace.length === 0) throw new KiokukoError('VALIDATION_ERROR', 'Official source persistence input is invalid');
  const prepared = validatePrepared(input.prepared);
  const now = input.now ?? new Date().toISOString();
  let imported = 0;
  const sources: SourceSyncResult['sources'] = [];
  for (const preparedSource of prepared.sources) {
    if (preparedSource.commit === null) {
      sources.push({ sourceId: preparedSource.sourceId, commit: null, documents: 0, imported: 0, ...(preparedSource.error === undefined ? {} : { error: preparedSource.error }) });
      continue;
    }
    let sourceImported = 0;
    for (const document of preparedSource.documents) {
      const built = documentInput(workspace, document);
      const existing = database.prepare('SELECT entry_id AS id FROM entry_revisions WHERE workspace = ? AND content_hash = ? LIMIT 1').get<{ id: string }>(workspace, built.contentHash);
      try {
        recordEntryInTransaction(database, built.input, { now });
        if (!existing) sourceImported += 1;
      } catch (error) {
        if (error instanceof KiokukoError && error.code === 'SECURITY_REJECTION') continue;
        throw error;
      }
    }
    const source = sourceForId(preparedSource.sourceId);
    database.prepare(`
      INSERT INTO knowledge_sources (source_id, repository_url, ref_name, commit_sha, document_count, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET repository_url = excluded.repository_url,
        ref_name = excluded.ref_name, commit_sha = excluded.commit_sha,
        document_count = excluded.document_count, last_synced_at = excluded.last_synced_at
    `).run(source.id, source.repositoryUrl, source.ref, preparedSource.commit, preparedSource.documents.length, now);
    imported += sourceImported;
    sources.push({ sourceId: source.id, commit: preparedSource.commit, documents: preparedSource.documents.length, imported: sourceImported, ...(preparedSource.error === undefined ? {} : { error: preparedSource.error }) });
  }
  return { attempted: true, imported, sources };
}

export function persistOfficialSourceSync(database: SqliteDatabase, input: { workspace: string; prepared: PreparedOfficialSourceSync; now?: string }): SourceSyncResult {
  return withImmediateTransaction(database, () => persistOfficialSourceSyncInTransaction(database, input));
}

export async function syncOfficialSources(input: SourceSyncInput): Promise<SourceSyncResult> {
  const prepared = await prepareOfficialSourceSync({
    workspace: input.workspace,
    task: input.task,
    profile: input.profile,
    recommendedTags: input.recommendedTags,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  return persistOfficialSourceSync(input.database, {
    workspace: input.workspace,
    prepared,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}
