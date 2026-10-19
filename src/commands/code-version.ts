import { currentMemoryApplicability, assertMemoryApplicabilityUnchanged } from '../memory/applicability-context.js';
import { finalizeHistoryRecall, type HistoryDelivery } from '../memory/history-delivery.js';
import { withDeferredReadTransaction } from '../db/transaction.js';
import type { Command } from 'commander';
import { open } from 'node:fs/promises';
import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js';
import { recordCodeVersion, readOwnedCodeVersion } from '../memory/code-versions.js';
import { successEnvelope } from '../serialization/envelope.js';
export function registerCodeVersionCommands(cli: Command, dependencies: {
    withDatabase<T>(operation: (db: SqliteDatabase) => T | Promise<T>): Promise<T>;
}): void {
    const parent = cli.command('code-version').description('Retain reported code attempts as immutable non-authoritative ledger evidence');
    parent.command('show').argument('<version-id>').option('--cwd <path>').option('--max-output-chars <number>', 'Complete serialized response budget', '32000').option('--json').action(async (versionId: string, options: {
        cwd?: string;
        maxOutputChars: string;
    }) => {
        const value = await dependencies.withDatabase(async (db) => {
            const cwd = options.cwd ?? process.cwd(), project = await resolveProjectWorkspaceReadOnly(db, cwd);
            if (!project)
                throw new KiokukoError('NOT_FOUND', 'Code evidence requires a registered project');
            const base = withDeferredReadTransaction(db, () => {
                const context = currentMemoryApplicability(db, project.workspace, cwd), found = readOwnedCodeVersion(db, versionId, context);
                assertMemoryApplicabilityUnchanged(db, context, cwd);
                const historyDelivery: HistoryDelivery = { scope: 'provided_items', status: found.omissions.length ? 'partial' : 'complete', ancestors: [], codeVersions: found.items, omissions: found.omissions, storedData: true, untrusted: true, instructions: false, executionPermission: false };
                return { items: [], count: 0, characterCount: 0, truncated: false, historyDelivery };
            });
            return finalizeHistoryRecall(db, base, { workspace: project.workspace, cwd, maxOutputChars: Number(options.maxOutputChars), measure: packet => Array.from(JSON.stringify(successEnvelope('code-version.show', packet))).length + 1 });
        });
        process.stdout.write(JSON.stringify(successEnvelope('code-version.show', value)) + '\n');
    });
    parent.command('record').requiredOption('--input-json <file>').option('--cwd <path>').option('--json').action(async (options: {
        inputJson: string;
        cwd?: string;
        json?: boolean;
    }) => {
        const file = await open(options.inputJson, 'r');
        let raw: unknown;
        try {
            const limit = 256 * 1024;
            const before = await file.stat({ bigint: true });
            if (!before.isFile() || before.size > BigInt(limit))
                throw new KiokukoError('VALIDATION_ERROR', 'Code evidence input exceeds its regular-file byte bound');
            const buffer = Buffer.alloc(limit + 1);
            let used = 0;
            while (used < buffer.length) {
                const { bytesRead } = await file.read(buffer, used, buffer.length - used, null);
                if (!bytesRead)
                    break;
                used += bytesRead;
            }
            const after = await file.stat({ bigint: true });
            if (used > limit)
                throw new KiokukoError('VALIDATION_ERROR', 'Code evidence input exceeds 256 KiB');
            if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(used) !== after.size)
                throw new KiokukoError('CONFLICT', 'Code evidence input changed while being read');
            try {
                raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, used)));
            }
            catch {
                throw new KiokukoError('VALIDATION_ERROR', 'Code evidence input must be valid UTF-8 JSON');
            }
        }
        finally {
            await file.close();
        }
        const data = await dependencies.withDatabase(async (db) => {
            const cwd = options.cwd ?? process.cwd(), project = await resolveProjectWorkspaceReadOnly(db, cwd);
            if (!project)
                throw new KiokukoError('NOT_FOUND', 'Code evidence requires a registered project');
            return recordCodeVersion(db, raw, project.workspace, cwd);
        });
        process.stdout.write(JSON.stringify(successEnvelope('code-version.record', data)) + '\n');
    });
}
