import { setImmediate } from 'node:timers/promises';
import { isAbsolute } from 'node:path';
import type { Command } from 'commander';
import { databaseFileIdentity, openConnection } from '../db/connection.js';
import { initializeDatabase } from './init.js';
import { rebuildProfileMemoryBatch } from '../akinator/profile-memory-store.js';
import { KiokukoError } from '../errors.js';
import { successEnvelope } from '../serialization/envelope.js';

export function registerAkinatorMemoryCommands(cli: Command): void {
  cli.command('akinator-memory').description('Maintain the local profile search index')
    .command('rebuild').description('Rebuild or resume profile indexing in an explicitly selected database')
    .requiredOption('--database <path>', 'Absolute path to an existing database')
    .option('--workspace <name>', 'Only rebuild this registered project')
    .option('--restart', 'Discard the projection and restart its rebuild')
    .option('--json')
    .action(async (options: { database: string; workspace?: string; restart?: boolean; json?: boolean }) => {
      if (!isAbsolute(options.database)) throw new KiokukoError('VALIDATION_ERROR', '--database must be an absolute path');
      if (options.workspace !== undefined && options.workspace.trim().length === 0) throw new KiokukoError('VALIDATION_ERROR', '--workspace must not be empty');
      const identity = databaseFileIdentity(options.database);
      await initializeDatabase({ databasePath: options.database });
      const database = openConnection(options.database, { expectedFileIdentity: identity });
      try {
        const projects = database.prepare(`SELECT workspace FROM repositories ${options.workspace ? 'WHERE workspace = ?' : ''} ORDER BY workspace`)
          .all<{ workspace: string }>(...(options.workspace ? [options.workspace] : []));
        if (options.workspace && projects.length === 0) throw new KiokukoError('NOT_FOUND', 'Workspace is not registered');
        if (!options.json) process.stderr.write('Rebuilding profile memory index; existing history may take time.\n');
        let processed = 0;
        for (const project of projects) {
          let first = true;
          for (;;) {
            const batch = rebuildProfileMemoryBatch(database, { workspace: project.workspace, restart: first && options.restart === true });
            first = false;
            processed += batch.processed;
            if (batch.complete) break;
            await setImmediate();
          }
        }
        const data = { projects: projects.length, processed, complete: true };
        process.stdout.write(options.json ? `${JSON.stringify(successEnvelope('akinator-memory.rebuild', data))}\n` : `Profile memory index ready (${processed} profiles, ${projects.length} projects).\n`);
      } finally { database.close(); }
    });
}
