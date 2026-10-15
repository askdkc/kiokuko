import { observationSchema, type MemoryRecordResponse, type MemoryContextResponse } from '../../memory/observation-contract.js';
import type { V1RouteHandler } from '../router.js';
import type { AgentRouteContext } from './agent-runs.js';
import { observeMemory, memoryContext, improveMemory } from '../../memory/observations.js';
import { requireNoQuery } from './agent-runs.js';
export function passiveMemoryOperation(method: string, pathname: string): string | undefined {
  const match = method === 'POST' ? /^\/api\/(?:v1\/)?memory\/(observe|context|improve)$/u.exec(pathname) : null;
  return match ? `memory.${match[1]}` : undefined;
}
export function createPassiveMemoryRoute(context: Pick<AgentRouteContext, 'database' | 'enqueueWrite'>): V1RouteHandler {
  const route: V1RouteHandler = async request => {
    const operation = passiveMemoryOperation(request.method, request.url.pathname);
    if (!operation) return undefined;
    requireNoQuery(request.url);
    const handler = operation === 'memory.observe' ? observeMemory : operation === 'memory.context' ? memoryContext : improveMemory;
    try {
      const value = await context.enqueueWrite<MemoryRecordResponse | MemoryContextResponse>(() => handler(context.database, request.body));
      return value;
    }
    catch { return { accepted: false, recorded: false, available: false, entries: [], handoff: null,
      workMayContinue: true, warnings: ['memory_storage_unavailable'] }; }
  };
  return route;
}
