import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTemporalConstraint } from '../../src/memory/temporal.js';

test('normalizes absolute temporal bounds and keeps an explicit request anchor', () => {
  assert.deepEqual(normalizeTemporalConstraint({
    basis: 'recorded', mode: 'restrict', start: '2026-01-01T09:00:00+09:00',
    end: '2026-01-02T00:00:00Z', anchorTime: '2026-01-03T00:00:00Z', timezone: 'Asia/Tokyo',
  }), {
    basis: 'recorded', mode: 'restrict', start: '2026-01-01T00:00:00.000Z',
    end: '2026-01-02T00:00:00.000Z', anchorTime: '2026-01-03T00:00:00.000Z', timezone: 'Asia/Tokyo',
  });
});

test('rejects impossible dates, empty windows, invalid zones, and unknown fields', () => {
  const base = { basis: 'recorded', mode: 'restrict', start: '2026-01-01T00:00:00Z', anchorTime: '2026-01-03T00:00:00Z', timezone: 'UTC' };
  assert.throws(() => normalizeTemporalConstraint({ ...base, start: '2026-02-30T00:00:00Z' }));
  assert.throws(() => normalizeTemporalConstraint({ ...base, end: '2025-12-31T23:59:59Z' }));
  assert.throws(() => normalizeTemporalConstraint({ ...base, timezone: 'Mars/Olympus' }));
  assert.throws(() => normalizeTemporalConstraint({ ...base, fuzzy: true }));
  assert.throws(() => normalizeTemporalConstraint({ ...base, start: undefined }));
});
