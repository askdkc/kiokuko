import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { readEntry } from '../memory/entries.js';
import {
  activeExternalSkillReferenceCandidateSql,
  externalSkillReferenceCandidateSql,
  isFederatedEcosystemCandidate,
} from '../memory/federated-retrieval.js';
import { isRetrievableEntry } from '../memory/hybrid-retrieval.js';
import { GLOBAL_WORKSPACE } from '../memory/workspaces.js';
import { canonicalContentHash, compareCanonicalStrings } from '../serialization/validate.js';
import { isExternalSkillReference, readExternalSkill } from '../skills/store.js';
import { contextFeedbackSignals } from './feedback.js';

export const CONTEXT_SELECTION_STATE_MAX_ENTRIES = 10_000;
const MAX_SELECTION_WORKSPACES = 2;
const MAX_WORKSPACE_BYTES = 256;
const CONTROL_CHARACTERS = /\p{C}/u;

function normalizedWorkspaces(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length > MAX_SELECTION_WORKSPACES) {
    throw new KiokukoError('VALIDATION_ERROR', 'Context selection workspaces are invalid');
  }
  const workspaces = value.map((workspace) => {
    if (typeof workspace !== 'string'
      || workspace.length === 0
      || workspace.trim() !== workspace
      || CONTROL_CHARACTERS.test(workspace)
      || Buffer.byteLength(workspace, 'utf8') > MAX_WORKSPACE_BYTES) {
      throw new KiokukoError('VALIDATION_ERROR', 'Context selection workspaces are invalid');
    }
    return workspace;
  });
  if (new Set(workspaces).size !== workspaces.length) {
    throw new KiokukoError('VALIDATION_ERROR', 'Context selection workspaces are invalid');
  }
  return workspaces.sort(compareCanonicalStrings);
}

function assertExternalEntryMappings(
  database: SqliteDatabase,
  workspaces: readonly string[],
  workspacePredicate: string,
  externalMarker: string,
): void {
  const mappedOrdinary = database.prepare(`
    SELECT e.id
      FROM entries AS e
     WHERE e.workspace IN (${workspacePredicate})
       AND e.status <> 'superseded'
       AND NOT ${externalMarker}
       AND EXISTS (
         SELECT 1 FROM external_skill_entries AS mapping WHERE mapping.entry_id = e.id
       )
     LIMIT 1
  `).get<{ id: unknown }>(...workspaces);
  if (mappedOrdinary !== undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'A managed external skill mapping points to an ordinary entry');
  }
  const corruptExternal = database.prepare(`
    SELECT e.id
      FROM entries AS e
     WHERE e.workspace IN (${workspacePredicate})
       AND e.status <> 'superseded'
       AND ${externalMarker}
       AND (
         (SELECT COUNT(*) FROM external_skill_entries AS mapping WHERE mapping.entry_id = e.id) <> 1
         OR NOT EXISTS (
           SELECT 1
             FROM external_skill_entries AS mapping
             JOIN external_skills AS skill ON skill.skill_id = mapping.skill_id
             JOIN entry_revisions AS revision
               ON revision.entry_id = mapping.entry_id
              AND revision.revision = mapping.entry_revision
            WHERE mapping.entry_id = e.id
              AND mapping.entry_revision = e.current_revision
              AND mapping.content_hash = revision.content_hash
              AND revision.workspace = e.workspace
         )
       )
     LIMIT 1
  `).get<{ id: unknown }>(...workspaces);
  if (corruptExternal !== undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context external entry mapping is missing');
  }
}

function searchSignalSnapshot(database: SqliteDatabase, entryId: string): Array<{ type: string; value: string }> {
  const rows = database.prepare(`
    SELECT signal_type AS type, normalized_value AS value
      FROM entry_search_signals
     WHERE entry_id = ?
     ORDER BY signal_type ASC, normalized_value ASC
  `).all<{ type: unknown; value: unknown }>(entryId);
  return rows.map((row) => {
    if (typeof row.type !== 'string' || row.type.length === 0
      || typeof row.value !== 'string' || row.value.length === 0) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored context search signal is invalid');
    }
    return { type: row.type, value: row.value };
  });
}

function externalSkillSnapshot(database: SqliteDatabase, entryId: string): Record<string, unknown> | null {
  const mappings = database.prepare(`
    SELECT skill_id AS skillId, source_path AS sourcePath, chunk_index AS chunkIndex,
           entry_revision AS entryRevision, content_hash AS contentHash,
           primary_document AS primaryDocument, active, imported_at AS importedAt
      FROM external_skill_entries
     WHERE entry_id = ?
     ORDER BY skill_id ASC, source_path ASC, chunk_index ASC
  `).all<Record<string, unknown>>(entryId);
  if (mappings.length === 0) return null;
  const skillIds = [...new Set(mappings.map((mapping) => mapping.skillId))];
  if (skillIds.length !== 1 || typeof skillIds[0] !== 'string') {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context external entry mapping is invalid');
  }
  const detail = readExternalSkill(database, skillIds[0]);
  if (detail === undefined) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Stored context external entry parent is missing');
  }
  return { skill: detail.skill, mappings };
}

function selectionEntrySnapshot(database: SqliteDatabase, entry: ReturnType<typeof readEntry>): Record<string, unknown> {
  const external = isExternalSkillReference(entry) ? externalSkillSnapshot(database, entry.id) : null;
  return {
    id: entry.id,
    workspace: entry.workspace,
    revision: entry.revision,
    kind: entry.kind,
    status: entry.status,
    trustLevel: entry.trustLevel,
    confidence: entry.confidence,
    title: entry.title,
    summary: entry.summary,
    body: entry.body,
    tags: [...entry.tags],
    scope: entry.scope,
    provenance: entry.provenance,
    contentHash: entry.contentHash,
    supersededBy: entry.supersededBy,
    createdBy: entry.createdBy,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    verifiedAt: entry.verifiedAt,
    searchSignals: searchSignalSnapshot(database, entry.id),
    ...(external === null ? {} : { external }),
    feedback: contextFeedbackSignals(database, entry.id),
  };
}

interface CandidateStateOptions {
  includeEcosystem: boolean;
  includeExternal: boolean;
}

function contextCandidateState(
  database: SqliteDatabase,
  relevantWorkspaces: readonly string[],
  options: CandidateStateOptions,
): { workspaces: string[]; entries: Record<string, unknown>[] } {
  const workspaces = normalizedWorkspaces(relevantWorkspaces);
  if (workspaces.length === 0 && !options.includeEcosystem) return { workspaces, entries: [] };
  const workspacePredicate = workspaces.map(() => '?').join(', ');
  const externalMarker = externalSkillReferenceCandidateSql();
  const activeExternal = activeExternalSkillReferenceCandidateSql();
  if (workspaces.length > 0) {
    assertExternalEntryMappings(database, workspaces, workspacePredicate, externalMarker);
  }
  if (options.includeEcosystem) {
    const mappedOrdinary = database.prepare(`
      SELECT e.id
        FROM external_skill_entries AS mapping
        JOIN entries AS e ON e.id = mapping.entry_id
       WHERE mapping.active = 1
         AND e.status <> 'superseded'
         AND NOT ${externalMarker}
       LIMIT 1
    `).get<{ id: unknown }>();
    if (mappedOrdinary !== undefined) {
      throw new KiokukoError('INTEGRITY_ERROR', 'A managed external skill mapping points to an ordinary entry');
    }
  }

  const clauses: string[] = [];
  const parameters: string[] = [];
  if (workspaces.length > 0) {
    clauses.push(`(e.workspace IN (${workspacePredicate}) AND NOT ${externalMarker})`);
    parameters.push(...workspaces);
  }
  if (options.includeExternal) {
    const externalWorkspace = options.includeEcosystem
      ? '1'
      : workspaces.length === 0
        ? '0'
        : `e.workspace IN (${workspacePredicate})`;
    clauses.push(`(${activeExternal}
      AND ${externalWorkspace}
    )`);
    if (!options.includeEcosystem && workspaces.length > 0) parameters.push(...workspaces);
  }
  if (options.includeEcosystem) {
    clauses.push(`(NOT ${externalMarker}
      AND EXISTS (
        SELECT 1 FROM entry_search_signals AS signal WHERE signal.entry_id = e.id
      ))`);
  }
  if (clauses.length === 0) return { workspaces, entries: [] };
  const rows = database.prepare(`
    SELECT e.id, e.workspace, CASE WHEN ${externalMarker} THEN 1 ELSE 0 END AS isExternal
      FROM entries AS e
     WHERE e.status <> 'superseded'
       AND (${clauses.join(' OR ')})
     ORDER BY e.workspace ASC, e.id ASC
     LIMIT ?
  `).all<{ id: unknown; workspace: unknown; isExternal: unknown }>(
    ...parameters,
    CONTEXT_SELECTION_STATE_MAX_ENTRIES + 1,
  );
  if (rows.length > CONTEXT_SELECTION_STATE_MAX_ENTRIES) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Context selection state exceeds the policy bound');
  }
  const relevant = new Set(workspaces);
  const entries = rows.flatMap((row) => {
    if (typeof row.id !== 'string'
      || typeof row.workspace !== 'string'
      || row.isExternal !== 0 && row.isExternal !== 1) {
      throw new KiokukoError('INTEGRITY_ERROR', 'Stored context selection state is invalid');
    }
    const entry = readEntry(
      database,
      { workspace: row.workspace, entryId: row.id },
      { requireStructuredScope: row.workspace === GLOBAL_WORKSPACE || row.isExternal === 1 },
    );
    if (entry.status === 'superseded') return [];
    const local = relevant.has(entry.workspace);
    const external = isExternalSkillReference(entry);
    if (external && !options.includeExternal) return [];
    const retrievable = local
      ? isRetrievableEntry(database, entry)
      : options.includeEcosystem && isFederatedEcosystemCandidate(database, entry);
    if (!retrievable) return [];
    return [selectionEntrySnapshot(database, entry)];
  });
  return { workspaces, entries };
}

/**
 * Hash the bounded ordinary-memory corpus that can affect model-facing context.
 * External skill references are deliberately excluded from memory capability gating.
 */
export function ordinaryContextSelectionStateHash(
  database: SqliteDatabase,
  relevantWorkspaces: readonly string[],
  options: { includeEcosystem?: boolean } = {},
): string {
  const state = contextCandidateState(database, relevantWorkspaces, {
    includeEcosystem: options.includeEcosystem === true,
    includeExternal: false,
  });
  return canonicalContentHash({
    workspaces: state.workspaces,
    includeEcosystem: options.includeEcosystem === true,
    entries: state.entries,
  });
}

/**
 * Hash every currently retrievable entry that can affect broker ranking or replay.
 * This is deliberately broader than the ordinary-memory capability gate above:
 * managed external Skill entries are context inputs and therefore part of this
 * state identity whenever their exact current mapping is active.
 */
export function contextRetrievalStateHash(
  database: SqliteDatabase,
  relevantWorkspaces: readonly string[],
  options: { includeEcosystem?: boolean } = {},
): string {
  const includeEcosystem = options.includeEcosystem === true;
  const state = contextCandidateState(database, relevantWorkspaces, {
    includeEcosystem,
    includeExternal: true,
  });
  return canonicalContentHash({ workspaces: state.workspaces, includeEcosystem, entries: state.entries });
}
