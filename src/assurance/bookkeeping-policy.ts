/** Only Kiokuko procedure/storage failures. Never classify authorization by absence. */
export const BOOKKEEPING_POLICY = 'Kiokuko preparation, pending or stale memory, review/verification registration and memory storage errors reject or suspend only the memory record. Continue unrelated coding only under existing host/OS/user authorization, using current repository evidence. Preserve the failed response and its original nextAction for record recovery; never infer persistence, verified completion or permission. Identity, ownership, access and host authorization denials remain denials. Obey user cancellation and host interruption.';
const reasons = new Set(['assurance_revision_changed', 'assurance_incomplete', 'run_awaiting_intake_answer',
  'task_verification_incomplete', 'verification_target_mismatch', 'verification_contract_missing']);
const storageCodes = new Set(['DATABASE_ERROR', 'BACKPRESSURE', 'SERVICE_UNAVAILABLE', 'MCP_REQUEST_TIMEOUT']);
export function isBookkeepingFailure(fields: Record<string, unknown>): boolean {
  if (['identity_violation','ownership_mismatch','access_denied','host_authorization_denied','request_interrupted','run_binding_mismatch','repository_binding_mismatch','request_id_reused'].includes(String(fields.reason)) || ['AUTHENTICATION_ERROR','SECURITY_REJECTION','MCP_REQUEST_CANCELLED'].includes(String(fields.code))) return false;
  if (fields.reason === 'run_terminal') return fields.runStatus === 'completed' || fields.runStatus === 'failed';
  return typeof fields.reason === 'string' && reasons.has(fields.reason)
    || typeof fields.code === 'string' && storageCodes.has(fields.code);
}
