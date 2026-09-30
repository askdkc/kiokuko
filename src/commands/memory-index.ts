import type { Command } from 'commander';
import type { SqliteDatabase } from '../db/adapter.js';
import { KiokukoError } from '../errors.js';
import { withImmediateTransaction } from '../db/transaction.js';
import { resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js';
import { indexMode } from '../memory/index-state.js';
export function registerMemoryIndexCommands(cli: Command, dependencies: {
    withDatabase: <T>(fn: (db: SqliteDatabase) => Promise<T>) => Promise<T>;
}) {
    const command = cli.command('memory-index').description('Maintain project-scoped atomic and bridging knowledge (host AI generates it)');
    const execute = async (action: string, options: {
        cwd: string;
        dryRun?: boolean;
    }, mode?: string) => dependencies.withDatabase(async (db) => {
        const project = await resolveProjectWorkspaceReadOnly(db, options.cwd);
        if (!project)
            throw new KiokukoError('NOT_FOUND', 'Project is not registered');
        if (mode !== undefined && !['off', 'observe', 'active'].includes(mode))
            throw new KiokukoError('VALIDATION_ERROR', 'Mode must be off, observe or active');
        if (mode)
            db.prepare('INSERT INTO memory_index_settings VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET mode=excluded.mode').run(project.workspace, mode);
        const sources = db.prepare("SELECT e.id,e.current_revision FROM entries e JOIN entry_revisions r ON r.entry_id=e.id AND r.revision=e.current_revision WHERE e.workspace=? AND e.status <> 'superseded' AND r.kind <> 'preference' AND e.created_by <> 'kiokuko-memory-index' AND COALESCE(json_extract(r.provenance_json,'$.type'),'') NOT IN ('memory_index','agent_derived_lesson','external_skill','source_sync') ORDER BY e.id").all<{
            id: string;
            current_revision: number;
        }>(project.workspace);
        if (action === 'rebuild' && !options.dryRun)
            withImmediateTransaction(db, () => {
                db.prepare("UPDATE memory_index_artifacts SET state='stale' WHERE entry_id IN (SELECT id FROM entries WHERE workspace=?)").run(project.workspace);
                for (const e of sources)
                    db.prepare('INSERT INTO memory_index_pending VALUES(?,?) ON CONFLICT(entry_id) DO UPDATE SET revision=excluded.revision').run(e.id, e.current_revision);
            });
        const data = { workspace: project.workspace, mode: indexMode(db, project.workspace), eligibleSources: sources.length, pending: db.prepare('SELECT COUNT(*) AS count FROM memory_index_pending p JOIN entries e ON e.id=p.entry_id WHERE e.workspace=?').get(project.workspace), artifacts: db.prepare('SELECT state,COUNT(*) AS count FROM memory_index_artifacts a JOIN entries e ON e.id=a.entry_id WHERE e.workspace=? GROUP BY state').all(project.workspace), dryRun: options.dryRun ?? false };
        process.stdout.write(JSON.stringify(data) + '\n');
        return;
    });
    command.command('status').option('--cwd <path>', 'Registered repository', process.cwd()).action(options => execute('status', options));
    command.command('mode <mode>').option('--cwd <path>', 'Registered repository', process.cwd()).action((mode, options) => execute('mode', options, mode));
    command.command('rebuild').option('--cwd <path>', 'Registered repository', process.cwd()).option('--dry-run', 'Report without changing the index').action(options => execute('rebuild', options));
}
