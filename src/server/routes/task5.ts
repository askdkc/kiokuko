import { successEnvelope } from '../../serialization/envelope.js';
import type { V1RouteHandler } from '../router.js';
import {
  decodeRunId,
  decimalQuery,
  queryParameters,
  requireIdempotencyKey,
  requireNoQuery,
  runIdSegment,
  type AgentRouteContext,
} from './agent-runs.js';
import { brokerPersistence } from './task5-support.js';

const CHECKPOINTS_SUFFIX = 'checkpoints';
const FEEDBACK_SUFFIX = 'feedback';
const DELIVERIES_SUFFIX = 'context-deliveries';
const CONTEXT_QUERY_PATH = '/api/v1/context/query';

async function brokerQuery(context: AgentRouteContext, body: unknown): Promise<unknown> {
  return context.broker.query(body, brokerPersistence(context));
}

export function createTask5Route(context: AgentRouteContext): V1RouteHandler {
  return async (request) => {
    if (request.method === 'POST') {
      const rawCheckpointRunId = runIdSegment(request.url.pathname, CHECKPOINTS_SUFFIX);
      if (rawCheckpointRunId !== undefined) {
        requireNoQuery(request.url);
        const runId = decodeRunId(rawCheckpointRunId);
        const idempotencyKey = requireIdempotencyKey(request);
        const data = await context.enqueueWrite(() => context.checkpointService.checkpoint({ runId, idempotencyKey, request: request.body }));
        let enriched: unknown = data;
        try {
          const result = await context.broker.query({ workspace: 'run-bound', runId, characterBudget: data.characterBudget }, brokerPersistence(context));
          enriched = { ...data, context: result.context, recommendations: result.recommendations };
        } catch {
          enriched = { ...data, context: null };
        }
        return successEnvelope('agent.checkpoint', enriched);
      }

      const rawFeedbackRunId = runIdSegment(request.url.pathname, FEEDBACK_SUFFIX);
      if (rawFeedbackRunId !== undefined) {
        requireNoQuery(request.url);
        const runId = decodeRunId(rawFeedbackRunId);
        const idempotencyKey = requireIdempotencyKey(request);
        const data = await context.enqueueWrite(() => context.feedbackService.feedback({ runId, idempotencyKey, request: request.body }));
        return successEnvelope('agent.feedback', data);
      }

      if (request.url.pathname === CONTEXT_QUERY_PATH) {
        requireNoQuery(request.url);
        const data = await brokerQuery(context, request.body);
        return successEnvelope('context.query', data);
      }
    }

    if (request.method === 'GET') {
      const rawRunId = runIdSegment(request.url.pathname, DELIVERIES_SUFFIX);
      if (rawRunId !== undefined) {
        const runId = decodeRunId(rawRunId);
        const values = queryParameters(request.url, ['cursor', 'limit']);
        const cursor = values.get('cursor');
        const limit = decimalQuery(values, 'limit');
        return successEnvelope('agent.context-deliveries.list', context.broker.listDeliveries({
          runId,
          ...(cursor === undefined ? {} : { cursor }),
          ...(limit === undefined ? {} : { limit }),
        }));
      }
    }

    return undefined;
  };
}

export function task5Operation(method: string, pathname: string): string | undefined {
  if (runIdSegment(pathname, CHECKPOINTS_SUFFIX) !== undefined) return 'agent.checkpoint';
  if (runIdSegment(pathname, FEEDBACK_SUFFIX) !== undefined) return 'agent.feedback';
  if (pathname === CONTEXT_QUERY_PATH) return 'context.query';
  if (runIdSegment(pathname, DELIVERIES_SUFFIX) !== undefined) return 'agent.context-deliveries.list';
  return undefined;
}
