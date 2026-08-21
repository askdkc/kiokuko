import { randomUUID } from 'node:crypto';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { canonicalContentHash, canonicalJson } from '../serialization/validate.js';
import type { EntryRecord } from '../memory/entries.js';
import { AKINATOR_POLICY_VERSION } from './domain.js';
import { deriveAkinatorReasoning } from './reasoning.js';
import { readAkinatorSession, readRunIntakeLink } from './store.js';

export type KnowledgeEvidenceTier = 'unobserved' | 'observed' | 'repeated' | 'portable';

export interface KnowledgeEvidence {
  conceptKey: string;
  totalPaths: number;
  qualifiedHits: number;
  independentRuns: number;
  independentWorkspaces: number;
  averageCompleteness: number;
  tier: KnowledgeEvidenceTier;
}

export interface RecordKnowledgePathsInput {
  runId: string;
  workspace: string;
  entries: EntryRecord[];
  outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  verification: {
    fresh: boolean;
    passedTests: number;
    passedCommands: number;
    evidenceCount: number;
  };
  createdAt: string;
  idFactory?: () => string;
}

interface EvidenceRow extends SqliteRow {
  total_paths: number;
  qualified_hits: number;
  independent_runs: number;
  independent_workspaces: number;
  average_completeness: number | null;
}

const ABSOLUTE_PATH = /(?:[A-Za-z]:[\\/]|\/(?:Users|home|workspace|private|tmp|var|opt)\/)[^\s"'`]+/giu;
const PROJECT_PHRASE = /\b(?:this|current|our)\s+(?:project|repository|repo)\b|(?:この|現在の|対象の)(?:プロジェクト|リポジトリ)/giu;

function normalizedConceptTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(ABSOLUTE_PATH, '<path>')
    .replace(PROJECT_PHRASE, '<project>')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function knowledgeConceptKey(entry: Pick<EntryRecord, 'title' | 'kind' | 'scope'>): string {
  const scope = entry.scope as Record<string, unknown>;
  return canonicalContentHash({
    kind: entry.kind,
    memoryClass: typeof scope.memoryClass === 'string' ? scope.memoryClass : null,
    title: normalizedConceptTitle(entry.title),
  });
}

export function recordKnowledgePathsInTransaction(
  database: SqliteDatabase,
  input: RecordKnowledgePathsInput,
): { recorded: number; qualified: number } {
  if (input.entries.length === 0) return { recorded: 0, qualified: 0 };
  const intake = readRunIntakeLink(database, { workspace: input.workspace, runId: input.runId });
  const session = readAkinatorSession(database, { workspace: input.workspace, sessionId: intake.sessionId });
  const reasoning = deriveAkinatorReasoning(session.task, session.profile);
  if (reasoning.selectedAction === null || session.profile.taskType === null) return { recorded: 0, qualified: 0 };

  const disqualificationReasons: string[] = [];
  if (input.outcome !== 'completed') disqualificationReasons.push('run-not-completed');
  if (reasoning.stage !== 'actionable' || reasoning.silo.completeness < 1) disqualificationReasons.push('reasoning-silo-incomplete');
  if (!input.verification.fresh && input.verification.passedTests === 0) disqualificationReasons.push('no-fresh-verification-or-passing-test');
  for (const field of ['target', 'expected'] as const) {
    const source = intake.profileSources[field];
    if (source !== 'client_supplied' && source !== 'user_answer') disqualificationReasons.push(`${field}-not-grounded`);
  }
  const qualified = disqualificationReasons.length === 0;
  const questionPath = (['taskType', 'target', 'expected', 'constraints'] as const)
    .filter((field) => session.profile[field] !== null)
    .map((field) => ({
      field,
      source: intake.profileSources[field] ?? 'inferred',
    }));
  const hypotheses = reasoning.hypotheses.map(({ id, status }) => ({ id, status }));
  const verification = {
    expected: session.profile.expected,
    fresh: input.verification.fresh,
    passedTests: input.verification.passedTests,
    passedCommands: input.verification.passedCommands,
    evidenceCount: input.verification.evidenceCount,
  };
  for (const entry of input.entries) {
    database.prepare(`
      INSERT OR IGNORE INTO akinator_reasoning_paths (
        path_id, concept_key, entry_id, entry_revision, run_id, intake_session_id,
        workspace, policy_version, task_type, intent, hypotheses_json,
        question_path_json, selected_action, conditions_json, verification_json,
        stop_conditions_json, silo_completeness, outcome, qualified,
        disqualification_reasons_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      (input.idFactory ?? randomUUID)(),
      knowledgeConceptKey(entry),
      entry.id,
      entry.revision,
      input.runId,
      intake.sessionId,
      input.workspace,
      `${AKINATOR_POLICY_VERSION}+${reasoning.policyVersion}`,
      session.profile.taskType,
      session.task,
      canonicalJson(hypotheses),
      canonicalJson(questionPath),
      reasoning.selectedAction,
      canonicalJson(reasoning.conditions),
      canonicalJson(verification),
      canonicalJson(reasoning.stopConditions),
      reasoning.silo.completeness,
      input.outcome,
      qualified ? 1 : 0,
      canonicalJson(disqualificationReasons),
      input.createdAt,
    );
  }
  return { recorded: input.entries.length, qualified: qualified ? input.entries.length : 0 };
}

export function readKnowledgeEvidence(
  database: SqliteDatabase,
  entry: Pick<EntryRecord, 'title' | 'kind' | 'scope'>,
): KnowledgeEvidence {
  const conceptKey = knowledgeConceptKey(entry);
  const row = database.prepare(`
    SELECT COUNT(*) AS total_paths,
           COUNT(DISTINCT CASE WHEN qualified = 1 THEN run_id END) AS qualified_hits,
           COUNT(DISTINCT CASE WHEN qualified = 1 THEN run_id END) AS independent_runs,
           COUNT(DISTINCT CASE WHEN qualified = 1 THEN workspace END) AS independent_workspaces,
           AVG(CASE WHEN qualified = 1 THEN silo_completeness END) AS average_completeness
      FROM akinator_reasoning_paths
     WHERE concept_key = ?
  `).get<EvidenceRow>(conceptKey);
  const totalPaths = Number(row?.total_paths ?? 0);
  const qualifiedHits = Number(row?.qualified_hits ?? 0);
  const independentRuns = Number(row?.independent_runs ?? 0);
  const independentWorkspaces = Number(row?.independent_workspaces ?? 0);
  const averageCompleteness = Number(Number(row?.average_completeness ?? 0).toFixed(3));
  const tier: KnowledgeEvidenceTier = qualifiedHits === 0
    ? totalPaths === 0 ? 'unobserved' : 'observed'
    : independentWorkspaces >= 2 ? 'portable'
      : independentRuns >= 2 ? 'repeated'
        : 'observed';
  return {
    conceptKey,
    totalPaths,
    qualifiedHits,
    independentRuns,
    independentWorkspaces,
    averageCompleteness,
    tier,
  };
}
