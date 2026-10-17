import assert from 'node:assert/strict';
import test from 'node:test';
import { planBindingRepair, type BindingRegistration } from '../../src/repository/binding-repair.js';
import { parseProjectConfig } from '../../src/config/project-config.js';
const root = '/registered/project';
const row: BindingRegistration = { canonicalRoot: root, repositoryId: 'repo_repair', workspace: 'project:repair', bindingSchemaVersion: 1, agentTemplateVersion: 34 };
const valid = { schemaVersion: 1, repositoryId: row.repositoryId, workspace: row.workspace, agentFile: 'nested/CUSTOM.md', templateVersion: 34 };

test('pure recovery retains registered identity and distinguishes new default settings from recovered custom settings', () => {
  const created = planBindingRepair(root, [row], undefined); assert.equal(created.kind, 'create');
  if (created.kind !== 'create') throw Error('missing create');
  assert.equal(created.config.repositoryId, row.repositoryId); assert.equal(created.config.workspace, row.workspace);
  assert.equal(created.config.agentFile, 'AGENTS.md'); assert.match(created.detail, /defaults/);
  const recreated = planBindingRepair(root, [row], JSON.stringify({ ...valid, schemaVersion: 'broken' }));
  assert.equal(recreated.kind, 'recreate'); if (recreated.kind !== 'recreate') throw Error('missing recreate');
  assert.equal(recreated.config.agentFile, valid.agentFile);
  assert.deepEqual(planBindingRepair(root, [row], JSON.stringify(valid)), { kind: 'unchanged', config: valid, detail: 'Existing binding identity matches registration' });
});

for (const [name, rows] of [
  ['unregistered location', []], ['ambiguous location', [row, row]],
  ['conflicting workspace', [row, { ...row, canonicalRoot: '/other', repositoryId: 'repo_other' }]],
  ['conflicting repository', [row, { ...row, canonicalRoot: '/other', workspace: 'project:other' }]],
  ['invalid template metadata', [{ ...row, agentTemplateVersion: -1 }]],
  ['invalid binding metadata', [{ ...row, bindingSchemaVersion: 0 }]],
] as const) test(`pure repair refuses ${name}`, () => { assert.equal(planBindingRepair(root, rows, undefined).kind, 'refuse'); });

for (const [name, original] of [
  ['valid foreign identity', JSON.stringify({ ...valid, repositoryId: 'repo_foreign' })],
  ['valid foreign workspace', JSON.stringify({ ...valid, workspace: 'project:foreign' })],
  ['broken schema with foreign identity', JSON.stringify({ ...valid, repositoryId: 'repo_foreign', schemaVersion: 'broken' })],
  ['newer schema', JSON.stringify({ ...valid, schemaVersion: 2 })],
]) test(`pure repair preserves ${name}`, () => { assert.equal(planBindingRepair(root, [row], original).kind, 'refuse'); });

test('location-only registration uses supported config defaults without inventing identity', () => {
  const result = planBindingRepair(root, [{ ...row, agentTemplateVersion: 0 }], undefined);
  assert.equal(result.kind, 'create'); if (result.kind !== 'create') throw Error('missing create');
  assert.equal(parseProjectConfig(result.config).repositoryId, row.repositoryId);
  assert.equal(planBindingRepair('/registered/../registered/project', [row], undefined).kind, 'refuse');
});
