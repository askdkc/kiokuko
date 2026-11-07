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
import { reviewPendingCaptureCandidate } from '../memory/capture-pending-review.js';
import { createApprovedReplayMemoryStore } from '../memory/replay-store.js';
import { nativeReplayReviewMessage } from '../mcp/replay-review.js';
import type { ReplayMemoryProposal } from '../memory/replay-review.js';

/** Standalone manual maintenance CLI, not a model-facing approval path.
 * isTTY checks interactivity, not authenticated human origin; model-controlled PTYs cannot establish consent.
 */
export function registerReplayReviewCommand(cli: Command): void {
  cli.command('memory-review').description('Manual terminal maintenance: review recorded experience or pending capture candidates (not an authenticated model approval channel)')
    .option('--trace <directory>', 'AgenticReplay trace directory (manual replay review)')
    .option('--task <id>', 'Task ID recorded for the reviewed trace (manual replay review)')
    .option('--session <id>', 'Session ID recorded for the reviewed trace (manual replay review)')
    .option('--pending', 'Review pending automatic capture candidates for this repository')
    .option('--cwd <directory>', 'Repository root', process.cwd()).option('--database <path>')
    .action(async (options: {trace?:string; task?:string; session?:string; pending?:boolean; cwd:string; database?:string}) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Manual memory review requires an interactive terminal; terminal access does not authenticate human approval');
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      const abort = new AbortController();
      const stop = () => abort.abort(); terminal.on('SIGINT', stop);
      try {
        if (options.pending) {
          if (options.trace || options.task || options.session) throw new Error('--pending reviews stored candidates and takes no trace, task or session');
          await reviewPendingCaptureCandidates({ cwd: options.cwd, databasePath: options.database ?? getGlobalDatabasePath(), terminal, signal: abort.signal });
          return;
        }
        if (!options.trace || !options.task || !options.session) throw new Error('Manual replay review requires --trace, --task and --session, or use --pending');
        const completed = (await terminal.question('Is the requested task actually complete? Type completed to continue: ')).trim() === 'completed';
        // Resolve from the existing database read-only, or a disposable in-memory schema.
        // A declined review must not create a database or register a repository.
        const databasePath = options.database ?? getGlobalDatabasePath();
        const trace = options.trace, task = options.task, session = options.session;
        const lookup = existsSync(databasePath) ? openConnection(databasePath, { readOnly: true }) : openConnection(':memory:');
        let binding;
        try {
          if (lookup.filePath === ':memory:') migrateDatabase(lookup);
          binding = await resolveProjectWorkspaceReadOnly(lookup, options.cwd);
        } finally { lookup.close(); }
        if (!binding) throw new Error('No repository');
        const receipt = await reviewCompletedReplay({ completed, taskId: task, sessionId: session, workspace: binding.workspace, signal: abort.signal,
          extract: () => extractReplayProposal({cwd:options.cwd,traceDirectory:trace,taskId:task,sessionId:session,workspace:binding.workspace}),
          ask: async q => {
            process.stdout.write(q.text + '\n');
            const response = await terminal.question('approve / decline / comment: ');
            const value = response.trim();
            return {questionId:q.id, choice:value === 'approve' ? 'approve' : value === 'decline' || !value ? 'decline' : 'revise', ...(value !== 'approve' && value !== 'decline' ? {comment:value} : {})};
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

/** Present the stored candidate exactly, then approve, decline or revise it. */
async function reviewPendingCaptureCandidates(input: { cwd: string; databasePath: string; terminal: import('node:readline/promises').Interface; signal: AbortSignal }): Promise<void> {
  const lookup = existsSync(input.databasePath) ? openConnection(input.databasePath, { readOnly: true }) : undefined;
  let workspace: string | undefined;
  try {
    if (lookup) {
      const binding = await resolveProjectWorkspaceReadOnly(lookup, input.cwd);
      workspace = binding?.workspace;
    }
  } finally { lookup?.close(); }
  if (!workspace) throw new Error('No repository');
  const listed = openConnection(input.databasePath, { readOnly: true });
  let candidateIds: string[] = [];
  try {
    candidateIds = listed.prepare(`SELECT candidate_id FROM memory_capture_candidates
      WHERE workspace = ? AND state = 'pending_review' ORDER BY created_at LIMIT 5`).all<{ candidate_id: string }>(workspace).map(row => row.candidate_id);
  } finally { listed.close(); }
  if (!candidateIds.length) {
    process.stdout.write('No pending memory candidates for this repository.\n');
    return;
  }
  await initializeDatabase({ databasePath: input.databasePath });
  const db = openConnection(input.databasePath);
  try {
    const project = await resolveProjectWorkspace(db, input.cwd);
    if (!project || project.workspace !== workspace) throw new Error('Repository binding changed during review');
    for (const candidateId of candidateIds) {
      if (input.signal.aborted) break;
      const receipt = await reviewPendingCaptureCandidate(db, {
        candidateId, workspace, signal: input.signal,
        present: proposal => {
          const message = nativeReplayReviewMessage(proposal);
          const lines = [
            `--- 候補 (revision ${proposal.revision}) ---`,
            ...(message ? [message] : [`記録された内容 (要約不能のため要点のみ): ${proposal.findings.map(finding => finding.text).join(' / ').slice(0, 800)}`]),
            ...proposal.source.traces.map(trace => `保存先: ${proposal.source.workspace} / 証拠: ${trace.runId}${trace.complete ? '' : ` (不完全: ${trace.gaps.join('; ')})`}`),
            '根拠は記録された実行結果であり、タスク全体の効果は未検証です。',
          ];
          const text = lines.join('\n');
          if (text.length <= 4000) process.stdout.write(text + '\n');
          return message ?? (text.length <= 4000 ? text : undefined);
        },
        ask: async question => {
          if (question.message === undefined) return { questionId: question.id, choice: 'decline' };
          const response = (await input.terminal.question('approve / decline / comment: ')).trim();
          return response === 'approve' ? { questionId: question.id, choice: 'approve' }
            : response === 'decline' || !response ? { questionId: question.id, choice: 'decline' }
            : { questionId: question.id, choice: 'revise', comment: response };
        },
      });
      process.stdout.write(`Memory candidate review: ${receipt.status}${receipt.status === 'saved' ? ` (${receipt.approvalKey!.slice(0, 12)}…)` : ''}. The completed task is unchanged.\n`);
      if (receipt.status === 'unavailable') process.stdout.write('候補の本文を表示できなかったため保存していません。後で同じ候補が再表示されます。\n');
    }
  } finally { db.close(); }
}
