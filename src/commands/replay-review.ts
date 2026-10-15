import { existsSync } from 'node:fs';
import { migrateDatabase } from '../db/migrate.js';
import type { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { getGlobalDatabasePath } from '../config/paths.js';
import { openConnection } from '../db/connection.js';
import { initializeDatabase } from './init.js';
import { resolveProjectWorkspace, resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js';
import { recordEntryInTransaction } from '../memory/entries.js';
import { extractReplayProposal } from '../memory/replay-extract.js';
import { reviewCompletedReplay } from '../memory/replay-review.js';
import { createApprovedReplayMemoryStore } from '../memory/replay-store.js';

/** Standalone manual maintenance CLI, not a model-facing approval path.
 * isTTY checks interactivity, not authenticated human origin; model-controlled PTYs cannot establish consent.
 */
export function registerReplayReviewCommand(cli: Command): void {
  cli.command('memory-review').description('Manual terminal maintenance: review recorded experience (not an authenticated model approval channel)')
    .requiredOption('--trace <directory>').requiredOption('--task <id>').requiredOption('--session <id>')
    .option('--cwd <directory>', 'Repository root', process.cwd()).option('--database <path>')
    .action(async (options: {trace:string; task:string; session:string; cwd:string; database?:string}) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Manual memory review requires an interactive terminal; terminal access does not authenticate human approval');
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      const abort = new AbortController();
      const stop = () => abort.abort(); terminal.on('SIGINT', stop);
      try {
        const completed = (await terminal.question('Is the requested task actually complete? Type completed to continue: ')).trim() === 'completed';
        // Resolve from the existing database read-only, or a disposable in-memory schema.
        // A declined review must not create a database or register a repository.
        const databasePath = options.database ?? getGlobalDatabasePath();
        const lookup = existsSync(databasePath) ? openConnection(databasePath, { readOnly: true }) : openConnection(':memory:');
        let binding;
        try {
          if (lookup.filePath === ':memory:') migrateDatabase(lookup);
          binding = await resolveProjectWorkspaceReadOnly(lookup, options.cwd);
        } finally { lookup.close(); }
        if (!binding) throw new Error('No repository');
        const receipt = await reviewCompletedReplay({ completed, taskId:options.task, sessionId:options.session, workspace:binding.workspace, signal:abort.signal,
          extract: () => extractReplayProposal({cwd:options.cwd,traceDirectory:options.trace,taskId:options.task,sessionId:options.session,workspace:binding.workspace}),
          ask: async q => {
            process.stdout.write(q.text + '\n');
            const response = await terminal.question(q.phase === 'organize' ? 'organize / decline: ' : 'approve / decline / comment: ');
            const value = response.trim();
            return {questionId:q.id, choice:value === 'organize' && q.phase === 'organize' ? 'organize' : value === 'approve' && q.phase === 'review' ? 'approve' : value === 'decline' || !value ? 'decline' : 'revise', ...(value !== 'approve' && value !== 'decline' && value !== 'organize' ? {comment:value} : {})};
          },
          save: async (proposal, key) => {
            await initializeDatabase({databasePath}); const db = openConnection(databasePath);
            try {
              const project = await resolveProjectWorkspace(db, options.cwd);
              if (!project || project.workspace !== binding.workspace) throw new Error('Repository binding changed during review');
              if (abort.signal.aborted) throw new Error('review_cancelled');
              createApprovedReplayMemoryStore(db, binding.workspace, p => {
                return recordEntryInTransaction(db, {workspace:project.workspace,kind:'reference',title:`Approved experience: ${p.request.text.slice(0,100) || p.source.taskId}`,
                  body:JSON.stringify(p),summary:p.findings.map(f => f.text).join('\n').slice(0,2048) || p.request.text.slice(0,2048),
                  tags:[...new Set([...p.tags,...p.keywords])].slice(0,20),scope:{visibility:'project'},
                  provenance:{type:'user_approved_replay',reference:key,evidenceIds:p.attempts.flatMap(a=>[a.callRef,...(a.resultRef?[a.resultRef]:[])])},
                  trustLevel:'untrusted',confidence:0.4,createdBy:'kiokuko-replay-review',actor:'user'});
              }).save(proposal,key);
            } finally {db.close();}
          },
        });
        process.stdout.write(`Memory review: ${receipt.status}. The completed task is unchanged.\n`);
      } finally {terminal.close();}
    });
}
