import semver from 'semver';
import { execFileSync } from 'node:child_process';
import { realpathSync, lstatSync, constants, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { parseProjectConfigText } from '../config/project-config.js';
import type { SqliteDatabase } from '../db/adapter.js';
import type { EntryRecord } from './entries.js';
import { canonicalContentHash } from '../serialization/validate.js';
import { KiokukoError } from '../errors.js';
/** Host-observed identity; model-facing schemas never accept owner or branch overrides. */
export interface MemoryApplicabilityContext {
    ownerId?: string;
    repositoryId?: string;
    repositoryRoot?: string;
    workspace: string;
    branch?: string;
    environment: Readonly<Record<string, string>>;
    bindingDigest?: string;
}
export type ApplicabilityState = 'compatible' | 'incompatible' | 'unknown';
export interface ApplicabilityDecision {
    state: ApplicabilityState;
    reasons: string[];
    constrained: boolean;
}
export function currentMemoryApplicability(db: SqliteDatabase, workspace: string, cwd?: string): MemoryApplicabilityContext {
    const repository = db.prepare('SELECT repository_id FROM repositories WHERE workspace=?').get<{
        repository_id: string;
    }>(workspace);
    const roots = repository ? db.prepare('SELECT canonical_root FROM repository_locations WHERE repository_id=? ORDER BY canonical_root').all<{
        canonical_root: string;
    }>(repository.repository_id) : [];
    let root: string | undefined;
    if (cwd !== undefined) {
        try {
            const canonical = realpathSync(cwd);
            root = roots.find(r => canonical === r.canonical_root || canonical.startsWith(r.canonical_root + '/'))?.canonical_root;
        }
        catch { /* An unknown location never falls back to a same-named directory. */ }
    }
    else if (roots.length === 1) {
        try {
            const registered = roots[0]!.canonical_root;
            if (realpathSync(registered) === registered)
                root = registered;
        }
        catch { /* An unavailable checkout remains unknown across repeated observations. */ }
    }
    let branch: string | undefined, bindingDigest: string | undefined;
    if (root !== undefined) {
        try {
            if (realpathSync(root) !== root)
                throw new Error('noncanonical');
            const env = { ...process.env };
            for (const key of Object.keys(env))
                if (key.startsWith('GIT_'))
                    delete env[key];
            const git = (args: string[]) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root!, ...args], { env, encoding: 'utf8', timeout: 3000, maxBuffer: 8192, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== root)
                throw new Error('unregistered checkout');
            const bindingPath = path.join(root, '.kiokuko.json');
            try {
                if (!lstatSync(bindingPath).isFile() || lstatSync(bindingPath).isSymbolicLink() || lstatSync(bindingPath).size > 65536)
                    throw new Error('unsafe binding');
                const fd = openSync(bindingPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
                let text: string;
                try {
                    const before = fstatSync(fd, { bigint: true });
                    if (!before.isFile() || before.size > 65536n)
                        throw new Error('binding size');
                    const buffer = Buffer.alloc(65537);
                    let used = 0;
                    while (used < buffer.length) {
                        const n = readSync(fd, buffer, used, buffer.length - used, null);
                        if (!n)
                            break;
                        used += n;
                    }
                    const after = fstatSync(fd, { bigint: true });
                    if (used > 65536 || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(used) !== after.size)
                        throw new Error('binding changed');
                    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used));
                }
                finally {
                    closeSync(fd);
                }
                const binding = parseProjectConfigText(text);
                if (binding.repositoryId !== repository?.repository_id || binding.workspace !== workspace)
                    throw new Error('binding changed');
                bindingDigest = canonicalContentHash(text);
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                    throw error;
            }
            const observed = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
            if (observed)
                branch = observed;
        }
        catch { /* Detached, missing, unsafe or unavailable identity stays unknown. */ }
    }
    return { workspace, ...(process.getuid ? { ownerId: `local:${process.getuid()}` } : {}), ...(repository ? { repositoryId: repository.repository_id } : {}), ...(root ? { repositoryRoot: root } : {}), ...(branch ? { branch } : {}), ...(bindingDigest ? { bindingDigest } : {}), environment: { platform: process.platform, arch: process.arch, node: process.versions.node } };
}
/** Exact identity constraints; absence of evidence is distinct from an observed mismatch. */
export function evaluateMemoryApplicability(entry: Pick<EntryRecord, 'scope'>, context: MemoryApplicabilityContext): ApplicabilityDecision {
    if (entry.scope.schemaVersion !== 3)
        return { state: 'unknown', reasons: ['legacy_applicability_unknown'], constrained: false };
    const value = entry.scope.applicability;
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return { state: 'unknown', reasons: ['applicability_unknown'], constrained: false };
    const constraints = value as Record<string, unknown>, reasons: string[] = [];
    let constrained = false, unknown = false, incompatible = false;
    for (const [key, actual] of [['ownerIds', context.ownerId], ['repositoryIds', context.repositoryId], ['workspaces', context.workspace], ['branches', context.branch]] as const) {
        const expected = constraints[key];
        if (!Array.isArray(expected) || expected.length === 0)
            continue;
        constrained = true;
        if (actual === undefined) {
            unknown = true;
            reasons.push(`${key}_unknown`);
        }
        else if (!expected.includes(actual)) {
            incompatible = true;
            reasons.push(`${key}_incompatible`);
        }
    }
    const environment = constraints.environment;
    if (typeof environment === 'object' && environment !== null && !Array.isArray(environment))
        for (const [key, expected] of Object.entries(environment)) {
            constrained = true;
            const actual = Object.hasOwn(context.environment, key) ? context.environment[key] : undefined;
            if (actual === undefined) {
                unknown = true;
                reasons.push('environment_unknown');
            }
            else if (key === 'node' && typeof expected === 'string' ? !semver.satisfies(actual, expected, { includePrerelease: true }) : actual !== expected) {
                incompatible = true;
                reasons.push('environment_incompatible');
            }
        }
    return { state: incompatible ? 'incompatible' : unknown || !constrained ? 'unknown' : 'compatible', reasons: [...new Set(reasons.length ? reasons : [constrained ? 'applicability_match' : 'applicability_unknown'])], constrained };
}
export function matchesMemoryApplicability(entry: Pick<EntryRecord, 'scope'>, context: MemoryApplicabilityContext): boolean {
    const decision = evaluateMemoryApplicability(entry, context);
    return !decision.constrained || decision.state === 'compatible';
}
export function assertMemoryApplicabilityUnchanged(db: SqliteDatabase, context: MemoryApplicabilityContext, cwd?: string): void {
    if (canonicalContentHash(context) !== canonicalContentHash(currentMemoryApplicability(db, context.workspace, cwd ?? context.repositoryRoot)))
        throw new KiokukoError('CONFLICT', 'Memory applicability changed during retrieval');
}
