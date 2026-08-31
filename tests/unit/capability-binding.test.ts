import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCapabilityCatalogBinding,
  bindCapabilityCatalog,
  bindKiokukoCapabilityCatalog,
  capabilityCatalogDigest,
  legacyCapabilityCatalogDigest,
} from '../../src/akinator/capability-binding.js';
import { normalizeCapabilityCatalog } from '../../src/akinator/capabilities.js';
import { STANDARD_SKILL_NAMES } from '../../src/setup/standard-skills.js';

test('capability catalog binding hashes the normalized descriptor set without depending on order or duplicates', () => {
  const first = [
    { kind: 'mcp_tool', name: 'repository_search', description: 'Search repository code' },
    { kind: 'skill', name: 'memory-reasoning', description: 'Verify remembered claims' },
  ];
  const reordered = [...first].reverse();
  assert.equal(legacyCapabilityCatalogDigest(first), 'dcadb89b1e8f1f31f0c6fb76bf6e49e2c95f21f0d32e5ba6418ad784a30958a9');
  assert.equal(legacyCapabilityCatalogDigest(first), legacyCapabilityCatalogDigest(reordered));
  assert.equal(legacyCapabilityCatalogDigest(first), legacyCapabilityCatalogDigest([...first, first[0], first[1]]));
  assert.notEqual(legacyCapabilityCatalogDigest(undefined), legacyCapabilityCatalogDigest([]));
  assert.notEqual(
    legacyCapabilityCatalogDigest(undefined),
    legacyCapabilityCatalogDigest([{ kind: 'invalid', name: 'discarded' }]),
  );
});

test('capability catalog binding changes for every effective descriptor change', () => {
  const catalog = [
    { kind: 'mcp_tool', name: 'repository_search', description: 'Search repository code' },
    { kind: 'skill', name: 'memory-reasoning', description: 'Verify remembered claims' },
  ];
  const digest = legacyCapabilityCatalogDigest(catalog);
  const variants = [
    catalog.slice(1),
    [...catalog, { kind: 'skill', name: 'new-skill' }],
    [{ ...catalog[0], name: 'repository_query' }, catalog[1]],
    [{ ...catalog[0], kind: 'skill' }, catalog[1]],
    [{ ...catalog[0], description: 'Query repository code' }, catalog[1]],
  ];
  for (const variant of variants) assert.notEqual(legacyCapabilityCatalogDigest(variant), digest);
});

test('a malformed catalog item does not erase separately valid descriptors', () => {
  const valid = { kind: 'skill', name: 'kiokuko-soul' };
  const mixed = [valid, { kind: 'invalid', name: 'broken-marketplace-entry' }];
  const normalized = normalizeCapabilityCatalog(mixed);
  assert.equal(normalized.availability, 'unknown');
  assert.deepEqual(normalized.skills, [valid]);
  assert.notEqual(legacyCapabilityCatalogDigest(mixed), legacyCapabilityCatalogDigest([]));
  assert.notEqual(legacyCapabilityCatalogDigest(mixed), legacyCapabilityCatalogDigest([valid]));
});

test('capability catalog binding accepts only the catalog bound at run open', () => {
  const catalog = [{ kind: 'skill', name: 'memory-reasoning' }];
  const metadata = bindCapabilityCatalog({ source: 'test' }, catalog);
  assert.doesNotThrow(() => assertCapabilityCatalogBinding(metadata, catalog));
  assert.doesNotThrow(() => assertCapabilityCatalogBinding(metadata, [...catalog, ...catalog]));
  assert.throws(
    () => assertCapabilityCatalogBinding(metadata, []),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'CONFLICT'
      && !error.message.includes(legacyCapabilityCatalogDigest(catalog)),
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

test('binding v2 owns only managed Kiokuko Skill names and the internal tool manifest', () => {
  const skills = [...STANDARD_SKILL_NAMES];
  const reordered = [...skills].reverse();
  const digest = capabilityCatalogDigest(skills);
  assert.equal(digest, capabilityCatalogDigest(reordered));
  assert.equal(digest, capabilityCatalogDigest([...skills, ...skills]));
  assert.notEqual(digest, capabilityCatalogDigest(skills.filter((name) => name !== 'memory-reasoning')));

  const metadata = bindKiokukoCapabilityCatalog({ source: 'test' }, skills);
  assert.doesNotThrow(() => assertCapabilityCatalogBinding(metadata, reordered));
  assert.throws(
    () => assertCapabilityCatalogBinding(metadata, skills.filter((name) => name !== 'kiokuko-soul')),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'CONFLICT',
  );
});
