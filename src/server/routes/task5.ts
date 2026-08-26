import { assertCapabilityCatalogBinding } from '../../akinator/capability-binding.js';
import { KiokukoError } from '../../errors.js';
import { checkpointEligibility } from '../../ledger/checkpoint-eligibility.js';
import type { RunStatus } from '../../ledger/types.js';
import { successEnvelope } from '../../serialization/envelope.js';
import type { V1RouteHandler } from '../router.js';
import {
  decodeRunId,
  requireIdempotencyKey,
  requireNoQuery,
  runIdSegment,
  type AgentRouteContext,
} from './agent-runs.js';
import { applyAgentCapabilityGate, assertBrokerContextRun, brokerIntakeStatus, deriveBrokerMemoryUseSignal, requestCapabilityCatalog } from './agent-capability-gate.js';
import { brokerPersistence } from './task5-support.js';
import { agentRequestBindingHash } from './request-binding.js';

const CHECKPOINTS_SUFFIX = 'checkpoints';
const FEEDBACK_SUFFIX = 'feedback';

function withoutCapabilityCatalog(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const result = { ...(value as Record<string, unknown>) };
  delete result.capabilities;
  return result;
}

function checkpointSignalArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Checkpoint signals are invalid after validation');
  }
  return [...value];
}

function checkpointSignals(value: unknown): { changedPaths: string[]; errorSignatures: string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Checkpoint signals are invalid after validation');
  }
  const request = value as Record<string, unknown>;
  return {
    changedPaths: checkpointSignalArray(request.changedPaths),
    errorSignatures: checkpointSignalArray(request.errorSignatures),
  };
}

function assertActiveCheckpointRun(run: { status: RunStatus }): void {
  const eligibility = checkpointEligibility(run.status);
  if (eligibility.allowed) return;
  throw new KiokukoError('CONFLICT', 'Checkpoint is not allowed for a non-active run', {
    checkpointEligibility: eligibility,
    runStatus: run.status,
  });
}

export function createTask5Route(context: AgentRouteContext): V1RouteHandler {
  return async (request) => {
    if (request.method === 'POST') {
      const rawCheckpointRunId = runIdSegment(request.url.pathname, CHECKPOINTS_SUFFIX);
      if (rawCheckpointRunId !== undefined) {
        requireNoQuery(request.url);
        const runId = decodeRunId(rawCheckpointRunId);
        const idempotencyKey = requireIdempotencyKey(request);
        const requestBindingHash = agentRequestBindingHash({
          operation: 'agent.checkpoint',
          pathRunId: runId,
          idempotencyKey,
          requestBody: request.body,
        });
        const catalog = requestCapabilityCatalog(request.body);
        const run = context.service.readRun({ runId });
        assertActiveCheckpointRun(run);
        assertCapabilityCatalogBinding(run.metadata, catalog);
        const serviceRequest = withoutCapabilityCatalog(request.body);
        const data = await context.enqueueWrite(() => context.checkpointService.checkpoint({
          runId,
          idempotencyKey,
          request: serviceRequest,
        }));
        const signals = checkpointSignals(serviceRequest);
        const brokerInput = {
          workspace: 'run-bound',
          runId,
          characterBudget: data.characterBudget,
          changedPaths: signals.changedPaths,
          errorSignatures: signals.errorSignatures,
        };
        const gated = await context.broker.queryGated(brokerInput, (candidate) => {
          assertBrokerContextRun(candidate, runId);
          const memoryUse = deriveBrokerMemoryUseSignal(context, candidate);
          const value = applyAgentCapabilityGate({
            task: run.title ?? '',
            intakeStatus: brokerIntakeStatus(candidate.status),
            taskProfile: candidate.taskProfile,
            recommendedTags: candidate.recommendedTags,
            catalog,
            broker: candidate,
            memoryUseOverride: memoryUse,
          });
          return {
            persist: value.nextAction !== 'required_capability_unavailable',
            value,
            assertBeforePersist: () => {
              if (deriveBrokerMemoryUseSignal(context, candidate) !== memoryUse) {
                throw new KiokukoError('CONFLICT', 'Memory capability decision changed before context persistence');
              }
            },
          };
        }, brokerPersistence(context));
        const finalRun = context.service.readRun({ runId });
        assertActiveCheckpointRun(finalRun);
        if (finalRun.lastSequence !== gated.broker.acceptedThrough) {
          throw new KiokukoError('CONFLICT', 'Agent run changed while checkpoint context was being prepared');
        }
        const intakeStatus = brokerIntakeStatus(gated.broker.status);
        if (intakeStatus === 'needs_answer' || gated.broker.projection === null) {
          throw new KiokukoError('INTEGRITY_ERROR', 'Checkpoint context is not bound to finalized intake');
        }
        const enriched = {
          ...data,
          runStatus: finalRun.status,
          intakeStatus,
          taskProfile: { ...gated.broker.taskProfile, source: 'akinator+ledger-revisions' },
          profileHash: gated.broker.profileHash,
          projection: gated.broker.projection,
          ...gated.value,
          requestBindingHash,
        };
        return successEnvelope('agent.checkpoint', enriched);
      }

      const rawFeedbackRunId = runIdSegment(request.url.pathname, FEEDBACK_SUFFIX);
      if (rawFeedbackRunId !== undefined) {
        requireNoQuery(request.url);
        const runId = decodeRunId(rawFeedbackRunId);
        const idempotencyKey = requireIdempotencyKey(request);
        const requestBindingHash = agentRequestBindingHash({
          operation: 'agent.feedback',
          pathRunId: runId,
          idempotencyKey,
          requestBody: request.body,
        });
        const data = await context.enqueueWrite(() => context.feedbackService.feedback({ runId, idempotencyKey, request: request.body }));
        return successEnvelope('agent.feedback', { ...data, requestBindingHash });
      }
    }

    return undefined;
  };
}

export function task5Operation(method: string, pathname: string): string | undefined {
  if (method !== 'POST') return undefined;
  if (runIdSegment(pathname, CHECKPOINTS_SUFFIX) !== undefined) return 'agent.checkpoint';
  if (runIdSegment(pathname, FEEDBACK_SUFFIX) !== undefined) return 'agent.feedback';
  return undefined;
}
