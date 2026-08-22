import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCapabilities } from '../../src/akinator/capabilities.js';

const buildProfile = {
  taskType: 'build' as const,
  target: 'src/beacon.ts',
  expected: 'The test suite passes',
  constraints: null,
};

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

test('enables mattpocock fallback only for an explicit catalog with zero skills', () => {
  const result = resolveCapabilities({
    task: 'Implement repository tests for the beacon',
    profile: buildProfile,
    recommendedTags: ['skill:tdd'],
    capabilities: [{ kind: 'mcp_tool', name: 'github_search_code' }],
  });

  assert.equal(result.catalogProvided, true);
  assert.equal(result.availableSkillCount, 0);
  assert.deepEqual(result.externalSkillFallback, {
    eligible: true,
    source: 'https://github.com/mattpocock/skills',
    reason: 'no_skills_available',
  });
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
