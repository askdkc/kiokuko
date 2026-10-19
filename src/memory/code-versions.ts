import semver from 'semver';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import * as z from 'zod/v4';
import type { SqliteDatabase, SqliteRow } from '../db/adapter.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { KiokukoError } from '../errors.js';
import { canonicalJson, canonicalContentHash } from '../serialization/validate.js';
import { LedgerStore } from '../ledger/store.js';
import { findSecretInValue } from './secrets.js';
import { currentMemoryApplicability, assertMemoryApplicabilityUnchanged, matchesMemoryApplicability, type MemoryApplicabilityContext } from './applicability-context.js';
import { readEntry } from './entries.js';
import type { HistoryOmission } from './entry-history.js';
const id = z.string().min(1).max(256).regex(/^[^\s\u0000-\u001f\u007f]+$/u);
export const codeVersionInputSchema = z.object({ runId: id, versionId: id, entryId: id.optional(), parentVersionId: id.optional(),
    path: z.string().min(1).max(1024), outcome: z.enum(['accepted', 'rejected', 'failed', 'unknown']), reason: z.string().min(1).max(2000), diff: z.string().min(1).max(64 * 1024), requiredEnvironment: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u), z.string().min(1).max(256)).refine(value => Object.keys(value).length <= 32 && (value.node === undefined || semver.validRange(value.node) !== null)).optional() }).strict();
export type CodeVersionInput = z.infer<typeof codeVersionInputSchema>;
export interface CodeVersionRow extends SqliteRow {
    version_id: string;
    evidence_id: string;
    run_id: string;
    entry_id: string | null;
    workspace: string;
    repository_id: string;
    owner_id: string;
    branch: string | null;
    parent_version_id: string | null;
    path: string;
    reported_outcome: CodeVersionInput['outcome'];
    reason: string;
    environment_json: string;
    required_environment_json: string | null;
    diff_text: string;
    diff_digest: string;
    binding_digest: string;
    created_at: string;
}
export interface CodeVersionView {
    versionId: string;
    parentVersionId: string | null;
    evidenceId: string;
    entryId: string | null;
    path: string;
    reportedOutcome: CodeVersionInput['outcome'];
    reason: string;
    diff: string;
    digest: string;
    environment: Record<string, string>;
    applicability: 'compatible' | 'unknown';
    requiredEnvironment?: Record<string, string>;
    untrusted: true;
    instructions: false;
    executionPermission: false;
    approval: 'not_granted';
}
function view(row: CodeVersionRow, applicability: 'compatible' | 'unknown'): CodeVersionView { return { versionId: row.version_id, parentVersionId: row.parent_version_id, evidenceId: row.evidence_id, entryId: row.entry_id, path: row.path, reportedOutcome: row.reported_outcome, reason: row.reason, diff: row.diff_text, digest: row.diff_digest, environment: JSON.parse(row.environment_json) as Record<string, string>, applicability, ...(row.required_environment_json === null ? {} : { requiredEnvironment: JSON.parse(row.required_environment_json) as Record<string, string> }), untrusted: true, instructions: false, executionPermission: false, approval: 'not_granted' }; }
function unavailable(): never { throw new KiokukoError('NOT_FOUND', 'Code version or its bound scope is unavailable'); }
/** Host scope is observed, never accepted from model-supplied metadata. One transaction owns evidence and immutable content. */
export function recordCodeVersion(db: SqliteDatabase, raw: unknown, workspace: string, cwd?: string): {
    versionId: string;
    evidenceId: string;
    digest: string;
    stored: true;
    duplicate: boolean;
    approval: 'not_granted';
} {
    const parsed = codeVersionInputSchema.safeParse(raw);
    if (!parsed.success)
        throw new KiokukoError('VALIDATION_ERROR', 'Code version evidence is invalid');
    const input = parsed.data;
    if (Buffer.from(input.diff, 'utf8').toString('utf8') !== input.diff || Buffer.byteLength(input.diff, 'utf8') > 64 * 1024 || path.isAbsolute(input.path) || input.path.split(/[\\/]/u).some(p => p === '..' || p === '.' || p === '.git' || p === '.env' || !p) || input.path.includes('\\') || /[\u0000-\u001f\u007f]/u.test(input.path))
        throw new KiokukoError('VALIDATION_ERROR', 'Code version path or byte bound is invalid');
    if (findSecretInValue(input))
        throw new KiokukoError('SECURITY_REJECTION', 'Code evidence resembles a secret and was not stored');
    const lines = input.diff.replaceAll('\r\n', '\n').split('\n');
    const before = lines.filter(line => line.startsWith('--- ')), after = lines.filter(line => line.startsWith('+++ '));
    const header = (line: string | undefined, prefix: string) => line === `${prefix} /dev/null` || line === `${prefix} ${prefix === '---' ? 'a' : 'b'}/${input.path}`;
    if (before.length !== 1 || after.length !== 1 || !header(before[0], '---') || !header(after[0], '+++') || !lines.some(line => /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(line)))
        throw new KiokukoError('VALIDATION_ERROR', 'Code evidence requires a single-file unified diff for its exact relative path');
    const context = currentMemoryApplicability(db, workspace, cwd);
    if (!context.ownerId || !context.repositoryId || !context.branch)
        throw new KiokukoError('CONFLICT', 'Code evidence requires an observed registered repository and branch', { reason: 'scope_unknown', disposition: 'not_evaluated' });
    const digest = createHash('sha256').update(input.diff, 'utf8').digest('hex');
    const binding = canonicalContentHash({ input, identity: { ownerId: context.ownerId, repositoryId: context.repositoryId, workspace, branch: context.branch }, digest });
    return withImmediateTransaction(db, () => {
        assertMemoryApplicabilityUnchanged(db, context, cwd);
        const run = new LedgerStore(db).readRun(input.runId, workspace);
        if (!run)
            unavailable();
        const prior = db.prepare('SELECT * FROM code_version_evidence WHERE version_id=? AND owner_id=? AND repository_id=? AND workspace=?').get<CodeVersionRow>(input.versionId, context.ownerId!, context.repositoryId!, workspace);
        if (prior) {
            if (prior.binding_digest !== binding)
                throw new KiokukoError('CONFLICT', 'Code version identity was reused with different evidence');
            return { versionId: prior.version_id, evidenceId: prior.evidence_id, digest: prior.diff_digest, stored: true as const, duplicate: true, approval: 'not_granted' as const };
        }
        if (db.prepare('SELECT 1 FROM code_version_evidence WHERE version_id=?').get(input.versionId))
            unavailable();
        if (input.parentVersionId === input.versionId)
            throw new KiokukoError('VALIDATION_ERROR', 'A code version cannot be its own parent');
        if (input.entryId) {
            const entry = readEntry(db, { workspace, entryId: input.entryId });
            if (!matchesMemoryApplicability(entry, context))
                unavailable();
            if (entry.scope.schemaVersion === 3 && entry.scope.repositoryId !== undefined && entry.scope.repositoryId !== context.repositoryId)
                unavailable();
        }
        if (input.parentVersionId) {
            const parent = db.prepare('SELECT path,branch,entry_id FROM code_version_evidence WHERE version_id=? AND owner_id=? AND repository_id=? AND workspace=?').get<{
                path: string;
                branch: string | null;
                entry_id: string | null;
            }>(input.parentVersionId, context.ownerId!, context.repositoryId!, workspace);
            if (!parent || parent.path !== input.path || parent.branch !== (context.branch ?? null) || parent.entry_id !== (input.entryId ?? null))
                unavailable();
        }
        const evidenceId = randomUUID(), now = new Date().toISOString();
        db.prepare("INSERT INTO ledger_evidence(evidence_id,run_id,event_id,kind,locator,digest_algorithm,digest,byte_size,summary,created_at) VALUES(?,?,NULL,'diff',?,'sha256',?,?,?,?)").run(evidenceId, input.runId, input.path, digest, Buffer.byteLength(input.diff, 'utf8'), `Reported ${input.outcome}; immutable raw code evidence; not approval`, now);
        db.prepare('INSERT INTO code_version_evidence(version_id,evidence_id,run_id,entry_id,workspace,repository_id,owner_id,branch,parent_version_id,path,reported_outcome,reason,environment_json,required_environment_json,diff_text,diff_digest,binding_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(input.versionId, evidenceId, input.runId, input.entryId ?? null, workspace, context.repositoryId!, context.ownerId!, context.branch ?? null, input.parentVersionId ?? null, input.path, input.outcome, input.reason, canonicalJson(context.environment), input.requiredEnvironment === undefined ? null : canonicalJson(input.requiredEnvironment), input.diff, digest, binding, now);
        assertMemoryApplicabilityUnchanged(db, context, cwd);
        return { versionId: input.versionId, evidenceId, digest, stored: true as const, duplicate: false, approval: 'not_granted' as const };
    });
}
/** No cross-owner row, identifier, count or expected environment is disclosed. Unknown branch never falls back. */
export function readCodeVersions(db: SqliteDatabase, context: MemoryApplicabilityContext, entryIds: readonly string[], maxVersions = 32): {
    items: CodeVersionView[];
    omissions: HistoryOmission[];
} {
    if (!Number.isSafeInteger(maxVersions) || maxVersions < 1 || maxVersions > 32 || entryIds.length > 1064)
        throw new KiokukoError('VALIDATION_ERROR', 'Code history bounds are invalid');
    if (!entryIds.length)
        return { items: [], omissions: [{ reason: 'not_evaluated', disposition: 'not_evaluated' }] };
    if (!context.ownerId || !context.repositoryId)
        return { items: [], omissions: [{ reason: 'scope_unknown', disposition: 'not_evaluated' }] };
    if (!context.branch)
        return { items: [], omissions: [{ reason: 'scope_unknown', disposition: 'not_evaluated' }] };
    // Per-seed index seeks bound candidate work; a global ORDER BY across IN(...)
    // would scan arbitrarily many versions before LIMIT. Materialize diff text only for selected IDs.
    const candidate = new Map<string, {
        version_id: string;
        created_at: string;
    }>();
    const seek = db.prepare('SELECT version_id,created_at FROM code_version_evidence WHERE owner_id=? AND repository_id=? AND workspace=? AND branch=? AND entry_id=? ORDER BY created_at DESC,version_id ASC LIMIT ?');
    for (const entryId of new Set(entryIds))
        for (const row of seek.all<{
            version_id: string;
            created_at: string;
        }>(context.ownerId, context.repositoryId, context.workspace, context.branch, entryId, maxVersions + 1))
            candidate.set(row.version_id, row);
    const ranked = [...candidate.values()].sort((a, b) => a.created_at > b.created_at ? -1 : a.created_at < b.created_at ? 1 : a.version_id < b.version_id ? -1 : a.version_id > b.version_id ? 1 : 0);
    const rows = ranked.slice(0, maxVersions).map(row => db.prepare('SELECT * FROM code_version_evidence WHERE version_id=? AND owner_id=? AND repository_id=? AND workspace=? AND branch=?').get<CodeVersionRow>(row.version_id, context.ownerId!, context.repositoryId!, context.workspace, context.branch!)!);
    return presentCodeVersions(db, context, rows, ranked.length > maxVersions);
}
function presentCodeVersions(db: SqliteDatabase, context: MemoryApplicabilityContext, rows: CodeVersionRow[], capped: boolean): {
    items: CodeVersionView[];
    omissions: HistoryOmission[];
} {
    const items: CodeVersionView[] = [], omissions: HistoryOmission[] = [];
    let lineageReads = 0;
    const lineage = new Map<string, {
        parent_version_id: string | null;
    } | undefined>();
    const validLineage = (row: CodeVersionRow): boolean => {
        const seen = new Set([row.version_id]);
        let parent = row.parent_version_id;
        for (let depth = 0; parent !== null && depth < 64; depth++) {
            if (seen.has(parent)) {
                omissions.push({ reason: 'missing_history', disposition: 'omitted' });
                return false;
            }
            seen.add(parent);
            const cacheKey = canonicalJson([parent, row.path, row.entry_id]);
            if (!lineage.has(cacheKey)) {
                if (lineageReads++ >= 128) {
                    omissions.push({ reason: 'node_cap', disposition: 'not_evaluated' });
                    return false;
                }
                lineage.set(cacheKey, db.prepare('SELECT parent_version_id FROM code_version_evidence WHERE version_id=? AND owner_id=? AND repository_id=? AND workspace=? AND branch=? AND path=? AND entry_id IS ?').get<{
                    parent_version_id: string | null;
                }>(parent, context.ownerId!, context.repositoryId!, context.workspace, context.branch!, row.path, row.entry_id));
            }
            const ancestor = lineage.get(cacheKey);
            if (!ancestor) {
                omissions.push({ reason: 'missing_history', disposition: 'omitted' });
                return false;
            }
            parent = ancestor.parent_version_id;
        }
        if (parent !== null) {
            omissions.push({ reason: 'depth_cap', disposition: 'not_evaluated' });
            return false;
        }
        return true;
    };
    if (capped)
        omissions.push({ reason: 'node_cap', disposition: 'not_evaluated' });
    for (const row of rows) {
        if (!validLineage(row))
            continue;
        const requirements = row.required_environment_json === null ? undefined : JSON.parse(row.required_environment_json) as Record<string, string>;
        let unknown = false, incompatible = false;
        for (const [key, expected] of Object.entries(requirements ?? {})) {
            const actual = Object.hasOwn(context.environment, key) ? context.environment[key] : undefined;
            if (actual === undefined)
                unknown = true;
            else if (key === 'node' ? !semver.satisfies(actual, expected, { includePrerelease: true }) : actual !== expected)
                incompatible = true;
        }
        if (incompatible || unknown) {
            omissions.push({ reason: incompatible ? 'environment_incompatible' : 'environment_unknown', disposition: 'omitted' });
            continue;
        }
        if (createHash('sha256').update(row.diff_text, 'utf8').digest('hex') !== row.diff_digest)
            throw new KiokukoError('INTEGRITY_ERROR', 'Stored code evidence digest is invalid');
        items.push(view(row, requirements && Object.keys(requirements).length ? 'compatible' : 'unknown'));
    }
    return { items, omissions };
}
/** Point lookup for the operator's raw evidence, including versions not linked to a memory. */
export function readOwnedCodeVersion(db: SqliteDatabase, versionId: string, context: MemoryApplicabilityContext): {
    items: CodeVersionView[];
    omissions: HistoryOmission[];
} {
    if (!context.ownerId || !context.repositoryId || !context.branch)
        return { items: [], omissions: [{ reason: 'scope_unknown', disposition: 'not_evaluated' }] };
    const row = db.prepare('SELECT * FROM code_version_evidence WHERE version_id=? AND owner_id=? AND repository_id=? AND workspace=? AND branch=?').get<CodeVersionRow>(versionId, context.ownerId, context.repositoryId, context.workspace, context.branch);
    if (!row)
        unavailable();
    return presentCodeVersions(db, context, [row], false);
}
