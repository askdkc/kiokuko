import { successEnvelope } from '../../serialization/envelope.js';
import type { V1RouteHandler } from '../router.js';
import {
  decodeRunId,
  isRunsPath,
  requireIdempotencyKey,
  requireNoQuery,
  runIdSegment,
  type AgentRouteContext,
} from './agent-runs.js';
import { attachInitialContext } from './task5-support.js';

const ANSWERS_SUFFIX = 'intake/answers';
const INTAKE_SUFFIX = 'intake';

export function createAgentIntakeRoute(context: AgentRouteContext): V1RouteHandler {
  return async (request) => {
    if (isRunsPath(request.url.pathname)) return undefined;

    if (request.method === 'POST') {
      const rawRunId = runIdSegment(request.url.pathname, ANSWERS_SUFFIX);
      if (rawRunId !== undefined) {
        const runId = decodeRunId(rawRunId);
        requireNoQuery(request.url);
        const idempotencyKey = requireIdempotencyKey(request);
        const data = await context.enqueueWrite(() => context.service.answerIntake({
          runId,
          idempotencyKey,
          request: request.body,
        }));
        return successEnvelope('agent.answer', await attachInitialContext(context, data.runId, data));
      }
    }

    if (request.method === 'GET') {
      const rawRunId = runIdSegment(request.url.pathname, INTAKE_SUFFIX);
      if (rawRunId !== undefined) {
        requireNoQuery(request.url);
        const runId = decodeRunId(rawRunId);
        return successEnvelope('agent.intake.read', context.service.readIntake({ runId }));
      }
    }

    return undefined;
  };
}

export function agentIntakeOperation(method: string, pathname: string): string | undefined {
  if (method === 'POST' && runIdSegment(pathname, ANSWERS_SUFFIX) !== undefined) return 'agent.answer';
  if (method === 'GET' && runIdSegment(pathname, INTAKE_SUFFIX) !== undefined) return 'agent.intake.read';
  return undefined;
}

