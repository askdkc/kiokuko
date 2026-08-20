import { persistOfficialSourceSync } from '../../knowledge/sources.js';
import { recordContextDeliveryInTransaction } from '../../context/delivery.js';
import { withImmediateTransaction } from '../../db/transaction.js';
import type { ContextBrokerPersistence, ContextBrokerResult } from '../../context/broker.js';
import type { AgentRouteContext } from './agent-runs.js';

export function brokerPersistence(context: AgentRouteContext): ContextBrokerPersistence {
  return {
    persistSources: (workspace, prepared) => context.enqueueWrite(() => persistOfficialSourceSync(context.database, { workspace, prepared })),
    persistDelivery: (input) => context.enqueueWrite(() => withImmediateTransaction(context.database, () => recordContextDeliveryInTransaction(context.database, input))),
  };
}

export async function attachInitialContext<T extends { intakeStatus?: string; context?: unknown }>(context: AgentRouteContext, runId: string, value: T): Promise<T & { context: ContextBrokerResult['context']; recommendations: ContextBrokerResult['recommendations'] }> {
  if (value.intakeStatus !== 'ready' && value.intakeStatus !== 'exhausted') {
    return { ...value, context: null, recommendations: [] };
  }
  try {
    const result = await context.broker.query({ workspace: 'run-bound', runId }, brokerPersistence(context));
    return { ...value, context: result.context, recommendations: result.recommendations };
  } catch {
    return { ...value, context: null, recommendations: [] };
  }
}
