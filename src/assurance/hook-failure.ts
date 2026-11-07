import { types } from 'node:util';
import * as z from 'zod/v4';
import { type ErrorCode, isErrorCode, KiokukoError, nativeErrorData } from '../errors.js';

const systemCode = z.enum(['EACCES', 'EPERM', 'ENOENT', 'EROFS', 'ENOSPC']);
const sqliteCodes = {
  8: 'SQLITE_READONLY',
  10: 'SQLITE_IOERR',
  13: 'SQLITE_FULL',
  14: 'SQLITE_CANTOPEN',
} as const;
const adapterError = 'adapter_error';

export const hookFailureSchema = z.object({
  stage: z.enum(['event_parse', 'binding_resolve', 'event_handle', 'completion_prepare', 'completion_binding', 'receipt_save', 'unknown']),
  errorClass: z.enum(['kiokuko', 'sqlite', 'system', 'error', 'unknown']),
  errorCode: z.union([
    systemCode,
    z.enum([...Object.values(sqliteCodes), 'ERR_SQLITE_ERROR', 'ERR_INVALID_STATE', 'unknown']),
    z.custom<ErrorCode>(isErrorCode),
  ]),
});
export type HookFailure = z.infer<typeof hookFailureSchema>;
interface HookFailureDescription { decision: string; reason: string; failure: HookFailure; }

function sqliteDiagnosticCode(code: unknown): HookFailure['errorCode'] {
  if (typeof code === 'number' && Number.isSafeInteger(code) && code >= 0) {
    return sqliteCodes[(code & 0xff) as keyof typeof sqliteCodes] ?? 'ERR_SQLITE_ERROR';
  }
  return 'ERR_SQLITE_ERROR';
}

function kiokukoFailureReason(code: string, message: unknown): string {
  if (code === 'CONFLICT') {
    if (message === 'Tool completion has no matching start') return 'completion_without_admission';
    if (message === 'Tool completion input changed') return 'completion_input_mismatch';
    if (message === 'Tool completion binding changed') return 'completion_binding_changed';
    return 'state_conflict';
  }
  if (code === 'BACKPRESSURE') return 'database_busy';
  if (code === 'SERVICE_UNAVAILABLE' && message === 'Repository state digest unavailable') return 'state_digest_unavailable';
  if (code === 'VALIDATION_ERROR' || code === 'INTEGRITY_ERROR') return 'validation_unavailable';
  return 'kiokuko_error';
}

function hasKiokukoErrorPrototype(error: Error): boolean {
  for (let prototype: unknown = Object.getPrototypeOf(error); prototype && !types.isProxy(prototype); prototype = Object.getPrototypeOf(prototype)) {
    if (prototype === KiokukoError.prototype) return true;
  }
  return false;
}

function describeNativeError(error: Error, stage: HookFailure['stage']): HookFailureDescription {
  const code = nativeErrorData(error, 'code');
  if (isErrorCode(code) && hasKiokukoErrorPrototype(error)) {
    return { decision: code, reason: kiokukoFailureReason(code, nativeErrorData(error, 'message')),
      failure: { stage, errorClass: 'kiokuko', errorCode: code } };
  }
  if (code === 'ERR_SQLITE_ERROR') {
    return { decision: adapterError, reason: 'database_error',
      failure: { stage, errorClass: 'sqlite', errorCode: sqliteDiagnosticCode(nativeErrorData(error, 'errcode')) } };
  }
  if (code === 'ERR_INVALID_STATE') {
    const message = nativeErrorData(error, 'message');
    if (typeof message === 'string' && /database is not open/iu.test(message)) {
      return { decision: adapterError, reason: 'database_error', failure: { stage, errorClass: 'sqlite', errorCode: code } };
    }
  }
  const system = systemCode.options.find(known => known === code);
  return {
    decision: adapterError,
    reason: typeof code === 'string' && code.startsWith('ERR_SQLITE') ? 'database_error' : adapterError,
    failure: system
      ? { stage, errorClass: 'system', errorCode: system }
      : { stage, errorClass: 'error', errorCode: 'unknown' },
  };
}

/** Preserve legacy routing separately from the allowlisted diagnostic. */
export function describeHookFailure(error: unknown, stage: HookFailure['stage']): HookFailureDescription {
  try {
    if (!types.isProxy(error) && types.isNativeError(error)) return describeNativeError(error, stage);
  } catch { /* Classifying the failure must never replace it. */ }
  return { decision: adapterError, reason: adapterError, failure: { stage, errorClass: 'unknown', errorCode: 'unknown' } };
}

export function codexHookFailureCode(error: unknown): string {
  return describeHookFailure(error, 'unknown').reason;
}
