import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CAPABILITY_ITEMS,
  MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS,
  MAX_RAW_CAPABILITY_DESCRIPTION_CHARS,
  compactCapabilityDescription,
  normalizeCapabilityCatalog,
  resolveCapabilities,
} from '../../src/akinator/capabilities.js';

const buildProfile = {
  taskType: 'build' as const,
  target: 'src/beacon.ts',
  expected: 'The test suite passes',
  constraints: null,
};

test('compacts capability descriptions deterministically without splitting Unicode code points', () => {
  const below = compactCapabilityDescription('a'.repeat(1_999));
  const unchanged = compactCapabilityDescription('a'.repeat(2_000));
  const shortened = compactCapabilityDescription('a'.repeat(2_001));
  const whitespace = compactCapabilityDescription('  first\n\tsecond\u0000 third  ');
  const emoji = compactCapabilityDescription('😀'.repeat(2_001));
  const normalized = compactCapabilityDescription('Ａ\n\tＢ  C');
  const controlsOnly = compactCapabilityDescription('\u0000\u0001\u200B');

  assert.deepEqual(below, { description: 'a'.repeat(1_999), truncated: false });
  assert.deepEqual(unchanged, { description: 'a'.repeat(2_000), truncated: false });
  assert.equal(Array.from(shortened.description).length, 2_000);
  assert.equal(shortened.description.endsWith('…'), true);
  assert.equal(whitespace.description, 'first second third');
  assert.equal(whitespace.truncated, false);
  assert.equal(Array.from(emoji.description).length, 2_000);
  assert.equal(emoji.description.endsWith('…'), true);
  assert.equal(emoji.description.includes('\uFFFD'), false);
  assert.deepEqual(normalized, { description: 'A B C', truncated: false });
  assert.deepEqual(controlsOnly, { description: '', truncated: false });
  assert.deepEqual(compactCapabilityDescription('a'.repeat(2_001)), shortened);
});

test('keeps raw description boundaries and degrades oversized values to name-only', () => {
  for (const length of [MAX_RAW_CAPABILITY_DESCRIPTION_CHARS - 1, MAX_RAW_CAPABILITY_DESCRIPTION_CHARS]) {
    const normalized = normalizeCapabilityCatalog([{ kind: 'skill', name: `raw-${length}`, description: 'x'.repeat(length) }]);
    assert.equal(normalized.skills[0]?.description?.length, 2_000);
    assert.equal(normalized.diagnostics.accepted, 1);
  }
  const raw = [{ kind: 'skill', name: 'raw-over', description: 'secret-private-path '.repeat(4_000) }];
  const normalized = normalizeCapabilityCatalog(raw);
  assert.deepEqual(normalized.skills, [{ kind: 'skill', name: 'raw-over' }]);
  assert.deepEqual(normalized.diagnostics, { received: 1, accepted: 1, truncated: 1, dropped: 0 });
  assert.equal(JSON.stringify(normalized).includes('secret-private-path'), false);
  assert.equal(raw[0]!.description.startsWith('secret-private-path'), true);
});

test('normalizes catalog entries individually and preserves catalog availability', () => {
  const raw = [
    { kind: 'skill', name: 'keep-this-name', description: 'x'.repeat(64_001) },
    { kind: 'unknown', name: 'drop-invalid-kind' },
    { kind: 'skill', name: '' },
    { kind: 'mcp_tool', name: 'keep-tool', description: 42 },
  ];
  const normalized = normalizeCapabilityCatalog(raw);

  assert.equal(normalized.availability, 'known-nonempty');
  assert.deepEqual(normalized.skills.map((item) => item.name), ['keep-this-name']);
  assert.deepEqual(normalized.tools.map((item) => item.name), ['keep-tool']);
  assert.equal(normalized.skills[0]?.description, undefined);
  assert.deepEqual(normalized.diagnostics, { received: 4, accepted: 2, truncated: 2, dropped: 2 });
  assert.deepEqual(raw[0], { kind: 'skill', name: 'keep-this-name', description: 'x'.repeat(64_001) });
});

test('keeps a valid recommendation when malformed catalog items are adjacent', () => {
  const result = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: ['skill:tdd'],
    capabilities: [
      { kind: 'invalid', name: 'before' },
      { kind: 'skill', name: 'tdd', description: 'Use a test-first implementation workflow.' },
      { kind: 'skill', name: '' },
    ],
  });

  assert.deepEqual(result.diagnostics, { received: 3, accepted: 1, truncated: 0, dropped: 2 });
  assert.ok(result.recommendations.some((item) => item.name === 'tdd'
    && item.availability === 'available'
    && item.source === 'akinator_policy'));
});

test('preserves nonempty fallback semantics at catalog item boundaries', () => {
  const twoHundred = Array.from({ length: MAX_CAPABILITY_ITEMS }, (_, index) => ({ kind: 'mcp_tool', name: `tool-${index}` }));
  const below = normalizeCapabilityCatalog(twoHundred.slice(0, 199));
  const exact = normalizeCapabilityCatalog(twoHundred);
  const over = normalizeCapabilityCatalog([...twoHundred, { kind: 'mcp_tool', name: 'tool-200' }]);
  const invalid = normalizeCapabilityCatalog([{ kind: 'invalid', name: 'invalid' }]);
  assert.deepEqual(below.diagnostics, { received: 199, accepted: 199, truncated: 0, dropped: 0 });
  assert.deepEqual(exact.diagnostics, { received: 200, accepted: 200, truncated: 0, dropped: 0 });
  assert.deepEqual(over.diagnostics, { received: 201, accepted: 200, truncated: 0, dropped: 1 });
  assert.equal(invalid.availability, 'known-nonempty');
  assert.deepEqual(invalid.diagnostics, { received: 1, accepted: 0, truncated: 0, dropped: 1 });
});

function aggregateCatalog(lastDescriptionLength: number, withUnreadSuffix = false): Array<unknown> {
  const catalog: Array<unknown> = [
    ...Array.from({ length: 7 }, () => ({ kind: 'mcp_tool', name: 'x', description: 'a'.repeat(MAX_RAW_CAPABILITY_DESCRIPTION_CHARS) })),
    { kind: 'skill', name: 'y', description: 'b'.repeat(lastDescriptionLength) },
  ];
  if (withUnreadSuffix) {
    Object.defineProperty(catalog, 8, {
      enumerable: true,
      get() { throw new Error('aggregate budget suffix was scanned'); },
    });
    catalog.length = 9;
  }
  return catalog;
}

test('enforces aggregate capability budget at minus-one, exact, and plus-one boundaries', () => {
  const finalExactDescription = MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS
    - (7 * MAX_RAW_CAPABILITY_DESCRIPTION_CHARS)
    - 8;
  const below = normalizeCapabilityCatalog(aggregateCatalog(finalExactDescription - 1));
  const exact = normalizeCapabilityCatalog(aggregateCatalog(finalExactDescription));
  const over = normalizeCapabilityCatalog(aggregateCatalog(finalExactDescription + 1, true));
  assert.equal(below.budgetExceeded, false);
  assert.equal(exact.budgetExceeded, false);
  assert.deepEqual(exact.diagnostics, { received: 8, accepted: 8, truncated: 8, dropped: 0 });
  assert.equal(over.availability, 'known-nonempty');
  assert.equal(over.budgetExceeded, true);
  assert.deepEqual(over.skills, [{ kind: 'skill', name: 'y' }]);
  assert.deepEqual(over.diagnostics, { received: 9, accepted: 8, truncated: 8, dropped: 1 });
  assert.deepEqual(normalizeCapabilityCatalog(aggregateCatalog(finalExactDescription + 1)).diagnostics, {
    received: 8, accepted: 8, truncated: 8, dropped: 0,
  });
});

test('reports a fixed budget warning without echoing omitted catalog content', () => {
  const finalExactDescription = MAX_RAW_CAPABILITY_CATALOG_CODE_POINTS
    - (7 * MAX_RAW_CAPABILITY_DESCRIPTION_CHARS)
    - 8;
  const result = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: ['skill:tdd'],
    capabilities: aggregateCatalog(finalExactDescription + 1),
  });
  assert.ok(result.warnings.some((warning) => warning.code === 'CAPABILITY_CATALOG_BUDGET_EXCEEDED'
    && warning.message === 'Some capability catalog data was omitted because the catalog exceeded its processing budget.'));
  assert.equal(JSON.stringify(result).includes('b'.repeat(2_001)), false);
  assert.equal(result.externalSkillFallback.eligible, false);
});

test('reports Akinator skill recommendations as unknown without a client catalog', () => {
  const result = resolveCapabilities({
    task: 'Implement a beacon',
    profile: buildProfile,
    recommendedTags: ['bot:builder', 'skill:tdd'],
  });

  assert.equal(result.catalogProvided, false);
  assert.equal(result.availableSkillCount, null);
  assert.deepEqual(result.externalSkillFallback, {
    eligible: false,
    source: 'https://github.com/mattpocock/skills',
    reason: 'capability_catalog_unknown',
  });
  assert.deepEqual(result.recommendations.map(({ kind, name, availability, source }) => ({ kind, name, availability, source })), [{
    kind: 'skill',
    name: 'tdd',
    availability: 'unknown',
    source: 'akinator_policy',
  }]);
});

test('matches available skills and relevant MCP tools without treating missing skills as installed', () => {
  const result = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: ['skill:tdd'],
    capabilities: [
      { kind: 'skill', name: 'mattpocock-skills:tdd', description: 'Test-first implementation' },
      { kind: 'skill', name: 'repository-explorer', description: 'Inspect repository code and tests' },
      { kind: 'mcp_tool', name: 'github_search_code', description: 'Search repository code and tests' },
      { kind: 'mcp_tool', name: 'calendar_list_events', description: 'List calendar events' },
    ],
  });

  assert.equal(result.availableSkillCount, 2);
  assert.equal(result.externalSkillFallback.reason, 'skills_available');
  assert.equal(result.externalSkillFallback.eligible, false);
  assert.ok(result.recommendations.some((item) => item.name === 'mattpocock-skills:tdd' && item.availability === 'available' && item.source === 'akinator_policy'));
  assert.ok(result.recommendations.some((item) => item.name === 'repository-explorer' && item.availability === 'available' && item.source === 'catalog_similarity'));
  assert.ok(result.recommendations.some((item) => item.name === 'github_search_code' && item.kind === 'mcp_tool'));
  assert.ok(!result.recommendations.some((item) => item.name === 'calendar_list_events'));
  assert.equal(result.recommendations.filter((item) => item.name.endsWith('tdd')).length, 1);
});

test('does not enable external fallback for a non-empty catalog without skills', () => {
  const result = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: ['skill:tdd'],
    capabilities: [{ kind: 'mcp_tool', name: 'github_search_code' }],
  });

  assert.equal(result.catalogProvided, true);
  assert.equal(result.availableSkillCount, 0);
  assert.deepEqual(result.externalSkillFallback, {
    eligible: false,
    source: 'https://github.com/mattpocock/skills',
    reason: 'capability_catalog_nonempty',
  });
});

test('enables external fallback only for an explicitly empty catalog', () => {
  const result = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: ['skill:tdd'],
    capabilities: [],
  });

  assert.equal(result.availability, 'known-empty');
  assert.equal(result.externalSkillFallback.eligible, true);
  assert.equal(result.externalSkillFallback.reason, 'no_skills_available');
});

test('does not enable external fallback for an unclassifiable catalog', () => {
  const result = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: ['skill:tdd'],
    capabilities: { skills: [] },
  });

  assert.equal(result.availability, 'unknown');
  assert.equal(result.externalSkillFallback.eligible, false);
  assert.equal(result.externalSkillFallback.reason, 'capability_catalog_unknown');
  assert.equal(result.warnings[0]?.code, 'CAPABILITY_CATALOG_UNAVAILABLE');
});

test('does not echo long or secret-like descriptions in capability warnings', () => {
  const secret = 'sk-live-secret-value';
  const result = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: [],
    capabilities: [{ kind: 'mcp_tool', name: 'safe-tool', description: `${secret} ${'x'.repeat(64_001)}` }],
  });

  assert.equal(result.availability, 'known-nonempty');
  assert.equal(result.diagnostics.truncated, 1);
  assert.equal(result.externalSkillFallback.eligible, false);
  assert.equal(result.warnings.some((warning) => warning.message.includes(secret)), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('recommends the standard UI skill for explicit English and Japanese UI work', () => {
  const capabilities = [{
    kind: 'skill' as const,
    name: 'kiokuko-ui-design-soul',
    description: 'Apply HIG principles to app and web UI design, implementation, and review.',
  }];
  for (const task of [
    'Review the SwiftUI screen and its asynchronous save button states',
    '画面の保存ボタンについて処理中・成功・失敗とアクセシビリティを実装する',
  ]) {
    const result = resolveCapabilities({
      task,
      profile: { ...buildProfile, target: 'app interface' },
      recommendedTags: ['bot:builder'],
      capabilities,
    });
    assert.ok(result.recommendations.some((item) => item.name === 'kiokuko-ui-design-soul'
      && item.availability === 'available'
      && item.source === 'akinator_policy'));
  }
});

test('does not recommend the UI skill for generic design, backend-only, or image-only tasks', () => {
  const capabilities = [{ kind: 'skill' as const, name: 'kiokuko-ui-design-soul' }];
  for (const task of [
    'Design the service architecture and database boundaries',
    'Implement a backend-only API for account records',
    'Create a landscape image; image generation only',
  ]) {
    const result = resolveCapabilities({
      task,
      profile: { ...buildProfile, target: 'service architecture' },
      recommendedTags: [],
      capabilities,
    });
    assert.ok(!result.recommendations.some((item) => item.name === 'kiokuko-ui-design-soul'));
  }
});
