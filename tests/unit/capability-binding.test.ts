import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCapabilityCatalogBinding,
  bindCapabilityCatalog,
  capabilityCatalogDigest,
} from '../../src/akinator/capability-binding.js';

test('capability catalog binding hashes the normalized catalog without depending on order', () => {
  const first = [
    { kind: 'mcp_tool', name: 'repository_search', description: 'Search repository code' },
    { kind: 'skill', name: 'memory-reasoning', description: 'Verify remembered claims' },
  ];
  const reordered = [...first].reverse();
  assert.equal(capabilityCatalogDigest(first), capabilityCatalogDigest(reordered));
  assert.notEqual(capabilityCatalogDigest(undefined), capabilityCatalogDigest([]));
  assert.notEqual(
    capabilityCatalogDigest(undefined),
    capabilityCatalogDigest([{ kind: 'invalid', name: 'discarded' }]),
  );
});

test('capability catalog binding accepts only the catalog bound at run open', () => {
  const catalog = [{ kind: 'skill', name: 'memory-reasoning' }];
  const metadata = bindCapabilityCatalog({ source: 'test' }, catalog);
  assert.doesNotThrow(() => assertCapabilityCatalogBinding(metadata, catalog));
  assert.throws(
    () => assertCapabilityCatalogBinding(metadata, []),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'CONFLICT'
      && !error.message.includes(capabilityCatalogDigest(catalog)),
  );
  assert.throws(
    () => assertCapabilityCatalogBinding({}, catalog),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'INTEGRITY_ERROR',
  );
  assert.throws(
    () => bindCapabilityCatalog(metadata, catalog),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
  );
});
