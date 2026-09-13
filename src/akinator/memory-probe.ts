import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { SqliteDatabase, SqliteValue } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { findSecret } from '../memory/secrets.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { memoryReasoningCapabilityAvailability, normalizeCapabilityCatalog } from './capabilities.js';
import { evaluateProfile } from './domain.js';
import { boundedProfileSignals, resolveProfileTarget } from './profile-memory-resolver.js';
import { assertProfileMemoryScope, readMemoryResolution, readProfileCandidate } from './profile-memory-store.js';
import {
  PROFILE_MEMORY_POLICY, PROFILE_MEMORY_MAX_CANDIDATES, PROFILE_MEMORY_HINT_CHARS,
  type MemoryResolution, type ProfileCandidate, type ProfileEvidence, type ProfileMemoryOptions, type MemoryHint,
} from './memory-probe-types.js';
import type { AkinatorResult, TaskProfile } from './types.js';

export function canUseProfileMemory(capabilities: unknown): boolean {
  const catalog = normalizeCapabilityCatalog(capabilities);
  return catalog.availability !== 'unknown' && !catalog.budgetExceeded
    && catalog.skills.some(skill => skill.name === 'kiokuko-soul')
    && memoryReasoningCapabilityAvailability(capabilities) === 'available';
}

/** Validate a literal current repository path; never resolve an old absolute or HOME path. */
function verifiedTarget(root: string, target: string, signals: ReadonlySet<string>): boolean {
  if (!signals.has(target) || target.length > 256 || target.includes('\\') || target.includes(':')
    || target.startsWith('/') || target.split('/').some(part => !part || part === '.' || part === '..')) return false;
  try {
    const location = path.resolve(root, target);
    const canonical = realpathSync(location);
    const relative = path.relative(root, canonical);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
    const status = statSync(canonical);
    return status.isFile() || status.isDirectory();
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

/** At most three index queries and 64 canonical expansions; synchronous SQL has no hard deadline. */
export function probeProfileMemory(database: SqliteDatabase, task: string, base: TaskProfile, options: ProfileMemoryOptions): { profile: TaskProfile; resolution: MemoryResolution } {
  const started = performance.now();
  const hash = canonicalContentHash(base);
  const resolution: MemoryResolution = {
    policyVersion: PROFILE_MEMORY_POLICY, mode: options.mode, status: 'skipped', coverage: 'partial',
    baseHash: hash, resultHash: hash, adoptedRunId: null, candidates: [], reason: 'searched',
    metrics: { queryCount: 0, expandedProfiles: 0, elapsedMs: 0, truncated: false },
  };
  const reason = options.mode === 'off' ? 'off' : !canUseProfileMemory(options.capabilities) ? 'capability_unavailable'
    : evaluateProfile(base, 0).missingFields.length === 0 ? 'profile_complete' : null;
  if (reason) { resolution.reason = reason; return { profile: { ...base }, resolution }; }
  options.signal?.throwIfAborted();
  assertProfileMemoryScope(database, options.scope);
  const { workspace, repositoryId, repositoryRoot } = options.scope;
  const state = database.prepare('SELECT complete FROM akinator_profile_projection_state WHERE workspace = ? AND repository_id = ? AND projection_version = 1')
    .get<{ complete: number }>(workspace, repositoryId);
  resolution.coverage = state?.complete === 1 ? 'complete' : 'partial';
  const bounded = boundedProfileSignals(task);
  const signals = bounded.signals;
  resolution.metrics.truncated = bounded.truncated;
  const candidates = new Map<string, ProfileCandidate>();
  let stale = false;
  const seen = new Set<string>();
  const collect = (sql: string, parameters: SqliteValue[], rankingScore: number): void => {
    options.signal?.throwIfAborted();
    if (performance.now() - started > 100) { resolution.metrics.truncated = true; return; }
    resolution.metrics.queryCount++;
    const rows = database.prepare(sql).all<{ run_id: string; session_id: string; profile_hash: string; source_hash: string }>(...parameters);
    if (rows.length >= PROFILE_MEMORY_MAX_CANDIDATES) resolution.metrics.truncated = true;
    for (const row of rows) {
      if (seen.has(row.run_id)) continue;
      if (seen.size === PROFILE_MEMORY_MAX_CANDIDATES) { resolution.metrics.truncated = true; break; }
      seen.add(row.run_id);
      if (seen.size === PROFILE_MEMORY_MAX_CANDIDATES) resolution.metrics.truncated = true;
      const evidence: ProfileEvidence = { runId: row.run_id, sessionId: row.session_id, repositoryId,
        profileHash: row.profile_hash, sourceHash: row.source_hash, rankingScore };
      const candidate = readProfileCandidate(database, workspace, evidence);
      resolution.metrics.expandedProfiles++;
      if (candidate) candidates.set(row.run_id, candidate);
      else stale = true;
    }
  };
  const fields = 'd.run_id, d.session_id, d.profile_hash, d.source_hash';
  if (signals.length) collect(`SELECT DISTINCT ${fields} FROM akinator_profile_signals s JOIN akinator_profile_documents d ON d.id = s.document_id
    WHERE s.workspace = ? AND s.repository_id = ? AND s.value IN (${signals.map(() => '?').join(',')})
      AND d.workspace = ? AND d.repository_id = ? AND d.projection_version = 1 ORDER BY d.run_id LIMIT 65`,
    [workspace, repositoryId, ...signals, workspace, repositoryId], 3);
  const terms = signals;
  for (const [table, score, tokens] of [
    ['akinator_profile_fts', 2, terms],
    ['akinator_profile_trigram', 1, terms.filter(term => [...term].length >= 3)],
  ] as const) {
    if (!tokens.length || resolution.metrics.truncated) continue;
    const query = tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' OR ');
    collect(`SELECT ${fields} FROM ${table} f JOIN akinator_profile_documents d ON d.id = f.rowid
      WHERE ${table} MATCH ? AND d.workspace = ? AND d.repository_id = ? AND d.projection_version = 1
      ORDER BY rank, d.run_id LIMIT 65`, [query, workspace, repositoryId], score);
  }
  resolution.candidates = [...candidates.values()].map(candidate => candidate.evidence);
  const signalSet = new Set(signals);
  const currentTargets = signals.filter(target => target.includes('/') || /\.[\p{L}\p{N}]+$/u.test(target)
    || verifiedTarget(repositoryRoot, target, signalSet));
  // One remembered file cannot stand in for a current request naming multiple paths.
  const verifiedTargets = new Set(currentTargets.length === 1 && verifiedTarget(repositoryRoot, currentTargets[0]!, signalSet) ? currentTargets : []);
  options.signal?.throwIfAborted();
  assertProfileMemoryScope(database, options.scope);
  if (performance.now() - started > 100) resolution.metrics.truncated = true;
  resolution.status = stale || resolution.coverage !== 'complete' || resolution.metrics.truncated ? 'incomplete' : 'complete';
  const resolved = resolveProfileTarget({ profile: base, mode: options.mode, complete: resolution.status === 'complete', candidates: [...candidates.values()], verifiedTargets });
  resolution.adoptedRunId = resolved.adoptedRunId;
  resolution.resultHash = canonicalContentHash(resolved.profile);
  resolution.metrics.elapsedMs = performance.now() - started;
  return { profile: resolved.profile, resolution };
}

/** Revalidate saved references for the current question; never search again on replay. */
export function profileMemoryHints(database: SqliteDatabase, runId: string, state: AkinatorResult, options: ProfileMemoryOptions): MemoryHint[] {
  if (options.mode === 'off' || options.mode === 'shadow' || !canUseProfileMemory(options.capabilities) || !state.question) return [];
  assertProfileMemoryScope(database, options.scope);
  const resolution = readMemoryResolution(database, options.scope.workspace, runId);
  if (!resolution || !['suggest', 'resolve'].includes(resolution.mode) || resolution.status === 'revoked') return [];
  const hints: MemoryHint[] = [];
  let characters = 0;
  const values = new Set<string>();
  for (const evidence of resolution.candidates) {
    if (evidence.repositoryId !== options.scope.repositoryId) throw new KiokukoError('INTEGRITY_ERROR', 'Profile memory hint scope mismatch');
    const source = readProfileCandidate(database, options.scope.workspace, evidence);
    if (!source || !source.ready) continue;
    const field = state.question.id;
    // A copied field must not re-expose a purged root through an intermediate run.
    if (source.sources[field] === 'memory') continue;
    const value = source.profile[field];
    if (!value || value.length > 1024 || values.has(value) || findSecret(value)) continue;
    const hint: MemoryHint = { field, value, reason: 'previous_example',
      source: { ...evidence, originalSource: source.sources[field] ?? 'inferred' }, verification: 'current_source', untrusted: true };
    const length = JSON.stringify(hint).length;
    if (characters + length > PROFILE_MEMORY_HINT_CHARS) break;
    characters += length;
    values.add(value);
    hints.push(hint);
    if (hints.length === 3) break;
  }
  return hints;
}
