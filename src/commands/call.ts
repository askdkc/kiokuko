export interface CallRequest {
  apiVersion: '1';
  operation: string;
  arguments: Record<string, unknown>;
}

export function parseCallRequest(value: unknown): CallRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Request must be a JSON object');
  const request = value as Record<string, unknown>;
  if (request.apiVersion !== '1' || typeof request.operation !== 'string') throw new Error('Invalid call request');
  const args = request.arguments;
  return { apiVersion: '1', operation: request.operation, arguments: typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {} };
}
