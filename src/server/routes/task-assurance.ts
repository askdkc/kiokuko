import { KiokukoError } from '../../errors.js';
import { reviewTaskMemory, recordTaskEvidence, taskAssuranceReport, assertAssuranceCwd } from '../../assurance/service.js';
import { refreshTaskMemory } from '../../assurance/refresh.js';
import { repositoryStateDigest } from '../../assurance/snapshot.js';
import { successEnvelope } from '../../serialization/envelope.js';
import { decodeRunId, requireIdempotencyKey, requireNoQuery, runIdSegment, type AgentRouteContext } from './agent-runs.js';
import type { V1RouteHandler } from '../router.js';
const suffixes = ['memory-review', 'execution-evidence', 'memory-refresh', 'memory-status'] as const;
export function taskAssuranceOperation(method: string, pathname: string): string | undefined {
  const suffix = method === 'POST' ? suffixes.find(s => runIdSegment(pathname, s) !== undefined) : undefined;
  return suffix ? `agent.${suffix}` : undefined;
}
export function createTaskAssuranceRoute(context: Pick<AgentRouteContext, 'database' | 'enqueueWrite'>): V1RouteHandler {
  return async request => {
    const operation = taskAssuranceOperation(request.method, request.url.pathname);
    if (!operation) return undefined;
    const suffix = operation.slice('agent.'.length);
    requireNoQuery(request.url);
    const runId = decodeRunId(runIdSegment(request.url.pathname, suffix)!);
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) throw new KiokukoError('VALIDATION_ERROR', 'Invalid assurance body');
    const body = request.body as Record<string, unknown>;
    if (Object.hasOwn(body, 'runId') || Object.hasOwn(body, 'requestId')) throw new KiokukoError('VALIDATION_ERROR', 'Run and request identities belong in path and header');
    const input = { ...body, runId, requestId: requireIdempotencyKey(request) };
    const data = await context.enqueueWrite(async () => {
      switch (suffix) {
        case 'memory-review': return reviewTaskMemory(context.database, input);
        case 'execution-evidence': return recordTaskEvidence(context.database, input);
        case 'memory-refresh': return refreshTaskMemory(context.database, input);
        default: {
          if (Object.keys(body).some(k => !['cwd', 'snapshot'].includes(k)) || typeof body.cwd !== 'string' || (body.snapshot !== undefined && typeof body.snapshot !== 'boolean')) throw new KiokukoError('VALIDATION_ERROR', 'Invalid status body');
          const state = assertAssuranceCwd(context.database, runId, body.cwd);
          return { ...taskAssuranceReport(context.database, runId), deliveryId: state.delivery_id,
            ...(body.snapshot === true ? { stateDigest: repositoryStateDigest(state.repository_root!) } : {}) };
        }
      }
    });
    return successEnvelope(`agent.${suffix}`, data);
  };
}
