import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnosticError } from '../../src/diagnostics/error.js';
import { KiokukoError } from '../../src/errors.js';

test('diagnostic errors retain useful codes and bound terminal-safe messages', () => {
  const error = new Error('Permission denied\n\u001b[31m' + 'x'.repeat(600));
  Object.assign(error, { code: 'EACCES' });
  const diagnostic = diagnosticError(error);
  assert.equal(diagnostic.code, 'EACCES');
  assert.equal(diagnostic.message.length, 512);
  assert.doesNotMatch(diagnostic.message, /[\u0000-\u001f\u007f-\u009f]/u);
  assert.deepEqual(diagnosticError(null), { code: 'INTERNAL_ERROR', message: 'Inspection threw a non-Error value' });
});

test('diagnostic errors redact secret material and omit details and stack traces', () => {
  const secret = 'sk-' + 'a'.repeat(48);
  const diagnostic = diagnosticError(new KiokukoError('VALIDATION_ERROR', `Invalid field: ${secret}`, { password: 'private' }));
  assert.equal(diagnostic.code, 'VALIDATION_ERROR');
  assert.match(diagnostic.message, /REDACTED/u);
  assert.ok(!JSON.stringify(diagnostic).includes(secret));
  assert.ok(!JSON.stringify(diagnostic).includes('private'));
  assert.deepEqual(Object.keys(diagnostic), ['code', 'message']);
});
