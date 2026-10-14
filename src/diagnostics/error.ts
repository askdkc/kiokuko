import { KiokukoError } from '../errors.js';
import { sanitizeJson } from '../security/sanitize.js';

/** Report a bounded exception without stack traces, error details or terminal controls. */
export function diagnosticError(error: unknown): { code: string; message: string } {
  const code = error instanceof KiokukoError ? error.code
    : error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'
      ? (error as NodeJS.ErrnoException).code! : 'INTERNAL_ERROR';
  const message = error instanceof Error ? error.message : 'Inspection threw a non-Error value';
  return {
    code: code.replace(/[^A-Z0-9_]/gu, '').slice(0, 64) || 'INTERNAL_ERROR',
    message: String(sanitizeJson(message).value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, 512),
  };
}
