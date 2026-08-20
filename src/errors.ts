export type ErrorCode =
  | 'USAGE_ERROR'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DATABASE_ERROR'
  | 'BACKPRESSURE'
  | 'SERVICE_UNAVAILABLE'
  | 'SECURITY_REJECTION'
  | 'AUTHENTICATION_ERROR'
  | 'INTEGRITY_ERROR'
  | 'PARTIAL_FAILURE'
  | 'NOT_IMPLEMENTED';

const EXIT_CODES: Record<ErrorCode, number> = {
  USAGE_ERROR: 2,
  VALIDATION_ERROR: 3,
  NOT_FOUND: 4,
  CONFLICT: 5,
  DATABASE_ERROR: 6,
  BACKPRESSURE: 6,
  SERVICE_UNAVAILABLE: 6,
  SECURITY_REJECTION: 7,
  AUTHENTICATION_ERROR: 7,
  INTEGRITY_ERROR: 8,
  PARTIAL_FAILURE: 9,
  NOT_IMPLEMENTED: 2,
};

export class KiokukoError extends Error {
  readonly exitCode: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'KiokukoError';
    this.exitCode = EXIT_CODES[code];
  }
}

export function exitCodeFor(error: unknown): number {
  if (error instanceof KiokukoError) return error.exitCode;
  return EXIT_CODES.DATABASE_ERROR;
}
