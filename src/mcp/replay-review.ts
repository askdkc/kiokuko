import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { realpath } from 'node:fs/promises';
import type { SqliteDatabase } from '../db/adapter.js';
import { LedgerStore } from '../ledger/store.js';
import { resolveProjectWorkspaceReadOnly } from '../memory/workspaces.js';
import { recordEntryInTransaction } from '../memory/entries.js';
import { createApprovedReplayMemoryStore } from '../memory/replay-store.js';
import { extractReplayProposal } from '../memory/replay-extract.js';
import { reviewCompletedReplay, type ReviewReceipt, type ReplayMemoryProposal } from '../memory/replay-review.js';
import { readCompletedDesktopTurn, type DesktopTurnIdentity } from '../assurance/codex-desktop-turn.js';
import { desktopReplayBinding, type DesktopReviewTurn } from './codex-desktop-review.js';
import { fitsNativeReview } from './memory-capture-presentation.js';

export function nativeReplayReviewMessage(proposal: ReplayMemoryProposal): string | undefined {
  const { source, request, findings, attempts, tags, keywords } = proposal;
  if (source.turnId) {
    const excerpt = (text: string, limit: number) => {
      const flat = text.replace(/\s+/gu, ' ').trim();
      return flat.length > limit ? flat.slice(0, limit) + ' […]' : flat;
    };
    const result = [...attempts].reverse().find(attempt => attempt.outputExcerpt);
    // Source evidence may be large. Keep every approved key point intact; label source excerpts.
    for (const limit of [120, 80, 40]) {
      const message = [
        `Save this experience to project memory? (revision ${proposal.revision})`,
        `Recorded task: ${source.taskOutcome ?? 'completed'}. Claims and tool results are unverified.`,
        `Request excerpt: ${excerpt(request.text, limit) || '(None captured)'}`,
        'Key points',
        ...(findings.length ? findings.map(finding => `• ${finding.text}`) : ['(None captured)']),
        ...(result ? [`Tool result excerpt (${result.tool}): ${excerpt(result.outputExcerpt!, limit)}`] : []),
        `AgenticReplay: ${source.traces.map(trace => trace.runId).join(', ')}; ${attempts.length} calls, ${attempts.filter(attempt => attempt.resultRef).length} results.`,
        'Approve saves these key points with linked request/tool evidence. Preview correction changes key points.',
      ].join('\n');
      if (fitsNativeReview(message)) return message;
    }
    return undefined;
  }
  const message = [
    `Save this experience to project memory? (revision ${proposal.revision})`,
    source.taskOutcome === 'failed' ? 'The recorded task ended in failure.' : 'The recorded task completed.',
    'Approve saves the displayed proposal. To change it, select Preview correction and enter corrected key points.',
    '',
    'Recorded request (untrusted source text)',
    request.text || '(No request captured)',
    'Key points',
    ...(findings.length ? findings.map(finding => `• ${finding.text}`) : ['(None captured)']),
    ...((tags.length || keywords.length) ? [`Search terms: ${[...new Set([...tags, ...keywords])].join(', ')}`] : []),
    `AgenticReplay: ${source.traces.map(trace => trace.runId).join(', ')}`,
    `Saved with evidence from ${attempts.length} recorded tool calls, including captured commands and result excerpts when available.`,
  ].join('\n');
  return fitsNativeReview(message) ? message : undefined;
}

function matchesDesktopTurn(db: SqliteDatabase, runId: string, root: string, turn?: DesktopTurnIdentity): boolean {
  if (!turn) return true;
  const binding = desktopReplayBinding(db, runId, root);
  return binding?.sessionId === turn.sessionId && binding.turnId === turn.turnId;
}

/** MCP elicitation responses come from the client UI, never a model tool argument. */
export function createMcpReplayReview(server: McpServer, withDatabase: <T>(fn:(db:SqliteDatabase)=>Promise<T>|T)=>Promise<T>) {
 const approved=new Map<string,{proposal:ReplayMemoryProposal;key:string}>();
 const active=new Set<string>();const finished=new Map<string,ReviewReceipt>();const abort=new AbortController();
 const unavailable=():ReviewReceipt=>({status:'unavailable',workMayContinue:true});
 return {
  close(){abort.abort();},
  async review(input:{runId:string;cwd:string;traceDirectory:string;desktopTurn?:DesktopReviewTurn},signal?:AbortSignal):Promise<ReviewReceipt>{
   const prior=finished.get(input.runId);if(prior)return prior;
   const pending=approved.get(input.runId);
   if(pending){
    try{const state=await withDatabase(db=>createApprovedReplayMemoryStore(db,pending.proposal.source.workspace).reconcile(pending.proposal,pending.key));
      const result:ReviewReceipt={status:state,workMayContinue:true,approvalKey:pending.key};
      if(state==='saved'){finished.set(input.runId,result);approved.delete(input.runId);}return result;
    }catch{return {...unavailable(),approvalKey:pending.key};}
   }
   if(!server.server.getClientCapabilities()?.elicitation || active.has(input.runId) || finished.size+approved.size>=256)return unavailable();
   active.add(input.runId);
   try{
    const root=await realpath(input.cwd);
    const binding=await withDatabase(async db=>{
      const run=new LedgerStore(db).readRun(input.runId);const project=await resolveProjectWorkspaceReadOnly(db,root);
      const recordedTurn = desktopReplayBinding(db, input.runId, root);
      if (!recordedTurn && db.prepare('SELECT 1 FROM codex_desktop_replay_bindings WHERE run_id = ?').get(input.runId)) return undefined;
      const desktopTurn = input.desktopTurn ?? (recordedTurn ? readCompletedDesktopTurn(recordedTurn, root) ?? undefined : undefined);
      if(!run||!['completed','failed'].includes(run.status)||!project||run.workspace!==project.workspace||project.repositoryRoot!==root
        ||(recordedTurn && !desktopTurn)||!matchesDesktopTurn(db,input.runId,root,desktopTurn))return undefined;
      return {workspace:run.workspace,sessionId:desktopTurn?.sessionId??run.client.sessionId??run.runId,taskOutcome:run.status as 'completed'|'failed',desktopTurn};
    });
    if(!binding)return {status:'not_completed',workMayContinue:true};
    const combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
    const receipt=await reviewCompletedReplay({completed:true,taskOutcome:binding.taskOutcome,workspace:binding.workspace,taskId:input.runId,sessionId:binding.sessionId,signal:combined,
      extract:()=>extractReplayProposal({cwd:root,traceDirectory:input.traceDirectory,workspace:binding.workspace,taskId:input.runId,sessionId:binding.sessionId,
        ...(binding.desktopTurn ? {desktopTurnId:binding.desktopTurn.turnId, desktopUserTextDigests:binding.desktopTurn.userTextDigests} : {})}),
      present:nativeReplayReviewMessage,
      ask:async question=>{
        const result = await server.server.elicitInput({
          mode: 'form', message: question.text,
          requestedSchema: {
            type: 'object',
            properties: {
              reviewAction: {
                type: 'string', title: 'On approval', default: 'save',
                oneOf: [
                  { const: 'save', title: 'Save displayed proposal' },
                  { const: 'revise', title: 'Preview correction' },
                ],
              },
              comment: { type: 'string', title: 'Correction (used only with Preview correction)', maxLength: 2048 },
            },
          },
        }, { signal: combined, timeout: 300_000 });
        if (result.action !== 'accept') return { questionId: question.id, choice: 'decline' };
        const comment = result.content?.comment;
        if (result.content?.reviewAction === 'revise') return { questionId: question.id, choice: 'revise', ...(typeof comment === 'string' ? { comment } : {}) };
        return { questionId: question.id, choice: 'approve' };
      },
      onApproved:(proposal,key)=>{approved.set(input.runId,{proposal,key});},
      save:async(proposal,key)=>withDatabase(async db=>{
        const run=new LedgerStore(db).readRun(input.runId);
        if(combined.aborted||run?.status!==binding.taskOutcome||run.workspace!==binding.workspace
          ||!matchesDesktopTurn(db,input.runId,root,binding.desktopTurn))throw new Error('review_binding_changed');
        createApprovedReplayMemoryStore(db,binding.workspace,p=>recordEntryInTransaction(db,{workspace:binding.workspace,kind:'reference',title:`Approved experience: ${p.request.text.slice(0,100)||p.source.taskId}`,body:JSON.stringify(p),summary:p.findings.map(f=>f.text).join('\n').slice(0,2048)||p.request.text.slice(0,2048),tags:[...new Set([...p.tags,...p.keywords])].slice(0,20),scope:{visibility:'project'},provenance:{type:'user_approved_replay',reference:key,evidenceIds:[...new Set([...p.findings.flatMap(f=>f.evidenceRefs),...p.request.evidenceRefs,...p.attempts.flatMap(a=>[a.callRef,...(a.resultRef?[a.resultRef]:[])])])].slice(0,200)},trustLevel:'untrusted',confidence:.4,createdBy:'kiokuko-replay-review',actor:'user'})).save(proposal,key);
      }),
    });
    if(receipt.status==='saved'||receipt.status==='declined'){finished.set(input.runId,receipt);approved.delete(input.runId);}
    return receipt;
   }catch{return unavailable();}finally{active.delete(input.runId);}
  },
 };
}
