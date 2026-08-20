import { KiokukoError } from '../errors.js';
import { AgentGatewayService } from '../gateway/agent-service.js';
import { CheckpointService, FeedbackService } from '../gateway/checkpoint-service.js';
import { ContextBroker } from '../context/broker.js';
import { startHttpServer, type HttpApplicationContext, type HttpServerHandle, type HttpServerOptions } from './http.js';
import type { V1RouteHandler } from './router.js';
import { createAgentEventsRoute, agentEventsOperation } from './routes/agent-events.js';
import { createAgentIntakeRoute, agentIntakeOperation } from './routes/agent-intake.js';
import { createAgentRunsRoute, agentRunsOperation, type AgentRouteContext } from './routes/agent-runs.js';
import { createAgentPromotionsRoute, agentPromotionsOperation } from './routes/agent-promotions.js';
import { createTask5Route, task5Operation } from './routes/task5.js';

export type AgentHttpServerOptions = Omit<HttpServerOptions, 'app' | 'v1' | 'applicationFactory'>;

function operationFor(method: string, pathname: string): string | undefined {
  return agentRunsOperation(method, pathname)
    ?? agentPromotionsOperation(method, pathname)
    ?? agentIntakeOperation(method, pathname)
    ?? agentEventsOperation(method, pathname)
    ?? task5Operation(method, pathname);
}

export function createAgentV1Handler(context: HttpApplicationContext): V1RouteHandler {
  const routeContext: AgentRouteContext = {
    database: context.database,
    service: new AgentGatewayService(context.database),
    checkpointService: new CheckpointService(context.database),
    feedbackService: new FeedbackService(context.database),
    broker: new ContextBroker(context.database),
    enqueueWrite: context.enqueueWrite,
  };
  const routes: readonly V1RouteHandler[] = [
    createAgentRunsRoute(routeContext),
    createAgentPromotionsRoute(routeContext),
    createAgentIntakeRoute(routeContext),
    createAgentEventsRoute(routeContext),
    createTask5Route(routeContext),
  ];
  const handler = (async (request) => {
    for (const route of routes) {
      const result = await route(request);
      if (result !== undefined) return result;
    }
    return undefined;
  }) as V1RouteHandler;
  handler.operationFor = ({ method, url }) => operationFor(method, url.pathname);
  return handler;
}

function rejectConflictingOptions(options: AgentHttpServerOptions): void {
  const unsafe = options as unknown as Record<string, unknown>;
  for (const key of ['app', 'v1', 'applicationFactory']) {
    if (Object.prototype.hasOwnProperty.call(unsafe, key)) {
      throw new KiokukoError('VALIDATION_ERROR', 'Agent server options cannot override the production application');
    }
  }
}

export async function startAgentHttpServer(options: AgentHttpServerOptions = {}): Promise<HttpServerHandle> {
  rejectConflictingOptions(options);
  return startHttpServer({
    ...options,
    applicationFactory: (context) => context.createAuthenticatedApp(createAgentV1Handler(context)),
  });
}
