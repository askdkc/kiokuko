/** Accept new schema labels only when the event fields this reader uses still fit. */
export function declaredReplaySchema(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 100
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function compatibleReplayEvent(value: unknown): value is Record<string, unknown> & { seq: number; type: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 1
    || typeof event.type !== 'string' || event.type.length === 0 || event.type.length > 100) return false;
  if (['user.message', 'model.request', 'tool.call', 'shell.call'].includes(event.type)) {
    return event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload);
  }
  return true;
}
