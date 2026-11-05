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

/** Human-facing summary only; original evidence and approval identity stay in the proposal. */
export function nativeReplayReviewMessage(proposal: ReplayMemoryProposal): string | undefined {
  const ids = [proposal.proposalId, proposal.source.workspace, proposal.source.taskId, proposal.source.sessionId,
    proposal.source.turnId, ...proposal.source.traces.flatMap(trace => [trace.runId, trace.eventsSha256]),
    ...proposal.attempts.flatMap(attempt => [attempt.attemptId, attempt.callRef, attempt.resultRef, ...attempt.payloadHashes]),
  ].filter((id): id is string => typeof id === 'string' && id.length >= 8);
  const readable = (text: string): string[] => text
    .replace(/^Recorded (?:final answer \(unverified\)|tool result \(task success unverified\)):\s*/u, '')
    .split(/\r?\n|\s+[-•]\s+|(?<=[。！？!?])\s*|(?<=[.!?])\s+/u)
    .map(part => part.replace(/^[\s#*•-]+/u, '').replace(/`/gu, '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim())
    .filter(part => part && !ids.some(id => part.includes(id))
      && !/\b(?:run_[a-f\d]{6,32}(?::\d+)?|call_[\w-]+|repo_[a-f\d]{6,32}|[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}|[a-f\d]{64})\b/iu.test(part)
      && !/^(?:(?:Kiokuko\s+)?(?:run|session|turn|task|proposal)(?:[_ -]?id)?\s*[:=：は]|(?:セッション|ターン|タスク|実行|提案)(?:ID|番号)\s*[:=：は]|自動承認処理|このターン終了後|承認(?:画面|後)|Task-level effectiveness remains unverified[.])/iu.test(part));
  const points = [...new Set(proposal.findings.flatMap(finding => readable(finding.text)))];
  if (!points.length) points.push(...readable(proposal.request.text));
  if (!points.length) return undefined;
  if (proposal.source.taskOutcome === 'failed') points.unshift('作業は失敗しました。');
  const width = (text: string) => Array.from(text).reduce((sum, character) => sum + (character.codePointAt(0)! > 0x7f ? 2 : 1), 0);
  const lines: string[] = [];
  for (const point of points) {
    let line = '';
    for (const character of point) {
      if (width(line + character) > 72) {
        const space = line.lastIndexOf(' ');
        const split = space >= line.length / 2 ? space : line.length;
        lines.push(line.slice(0, split).trim());
        line = line.slice(split).trimStart();
      }
      line += character;
    }
    if (line.trim()) lines.push(line.trim());
  }
  if (lines.length > 6) {
    lines.length = 6;
    let last = lines[5]!;
    while (width(last) > 70) last = Array.from(last).slice(0, -1).join('');
    lines[5] = last.trimEnd() + '…';
  }
  const message = '今回の内容を記憶として保存しますか？\n\n' + lines.join('\n');
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
          requestedSchema: { type: 'object', properties: {} },
        }, { signal: combined, timeout: 300_000 });
        if (result.action !== 'accept' || Object.keys(result.content ?? {}).length) return { questionId: question.id, choice: 'decline' };
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
