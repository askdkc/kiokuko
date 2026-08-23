import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { curateMemoryCandidates, curatorFacets, globalizeCuratorCandidate } from '../../src/memory/curator.js';
import { recordEntry } from '../../src/memory/entries.js';
import { buildStructuredScope } from '../../src/memory/structured-memory.js';
import { registerRepositoryAndLocation } from '../../src/repository/binding.js';

test('curator filters, facets, cursor pagination, and globalization visibility are server-side', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-curator-filters-'));
  const databasePath = path.join(directory, 'kiokuko.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    const projects = [
      { workspace: 'project:laravel', name: 'laravel-api', framework: 'Laravel', language: 'PHP', tag: 'Laravel', title: 'Laravel migration rollback pattern', body: 'When a Laravel migration fails, inspect the transaction and verify the schema before retrying.' },
      { workspace: 'project:svelte', name: 'svelte-web', framework: 'Svelte', language: 'TypeScript', tag: 'Svelte', title: 'Svelte state update pattern', body: 'When a Svelte state update is stale, verify the reactive assignment and rerender the component.' },
      { workspace: 'project:typescript', name: 'typescript-tool', framework: 'Vite', language: 'TypeScript', tag: 'TypeScript', title: 'TypeScript command validation workflow', body: 'When a TypeScript command changes, run the compiler and verify the generated output before release.' },
    ] as const;
    const entries = projects.map((project) => {
      registerRepositoryAndLocation(database, {
        repositoryId: `repo_${project.workspace.slice('project:'.length)}`,
        workspace: project.workspace,
        displayName: project.name,
        canonicalRoot: path.join(directory, project.name),
        remoteFingerprint: null,
        bindingSchemaVersion: 1,
        agentTemplateVersion: 1,
      });
      return recordEntry(database, {
        workspace: project.workspace,
        kind: 'lesson',
        status: 'candidate',
        title: project.title,
        body: project.body,
        summary: `Reusable ${project.framework} workflow.`,
        scope: buildStructuredScope({
          visibility: 'project',
          memoryClass: 'troubleshooting',
          applicability: { frameworks: [{ name: project.framework }], languages: [project.language] },
        }),
        tags: [project.tag, 'workflow'],
      });
    });
    const laravel = entries[0];
    assert.ok(laravel);

    const filtered = await curateMemoryCandidates(database, { allWorkspaces: true, tags: ['Laravel'], frameworks: ['Laravel'], languages: ['PHP'], memoryClasses: ['troubleshooting'] });
    assert.deepEqual(filtered.candidates.map((candidate) => candidate.entryId), [laravel.id]);

    const facets = curatorFacets(database);
    assert.ok(facets.projects.some((facet) => facet.workspace === 'project:laravel'));
    assert.ok(facets.tags.some((facet) => facet.value === 'Laravel'));
    assert.ok(facets.frameworks.some((facet) => facet.value === 'laravel'));
    assert.ok(facets.languages.some((facet) => facet.value === 'php'));
    assert.ok(facets.memoryClasses.some((facet) => facet.value === 'troubleshooting'));

    const firstPage = await curateMemoryCandidates(database, { allWorkspaces: true, limit: 1 });
    assert.equal(firstPage.candidates.length, 1);
    assert.ok(firstPage.nextCursor);
    const secondPage = await curateMemoryCandidates(database, { allWorkspaces: true, limit: 1, cursor: firstPage.nextCursor ?? undefined });
    assert.equal(secondPage.candidates.length, 1);
    assert.notEqual(secondPage.candidates[0]?.entryId, firstPage.candidates[0]?.entryId);

    globalizeCuratorCandidate(database, { workspace: laravel.workspace, entryId: laravel.id, expectedRevision: laravel.revision });
    const hidden = await curateMemoryCandidates(database, { allWorkspaces: true });
    assert.equal(hidden.candidates.some((candidate) => candidate.entryId === laravel.id), false);
    const shown = await curateMemoryCandidates(database, { allWorkspaces: true, includeGlobalized: true });
    assert.equal(shown.candidates.some((candidate) => candidate.entryId === laravel.id), true);
  } finally {
    database.close();
  }
});

test('curator cursor pagination reaches candidates beyond the first SQL scan batch', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-curator-pagination-'));
  const databasePath = path.join(directory, 'kiokuko.sqlite3');
  await initializeDatabase({ databasePath });
  const database = openConnection(databasePath);
  try {
    for (let index = 0; index < 501; index += 1) {
      recordEntry(database, {
        workspace: 'project:bulk-curator',
        kind: 'lesson',
        status: 'candidate',
        title: `Reusable migration workflow ${String(index).padStart(3, '0')}`,
        body: `Reusable workflow ${index}: when a migration fails, verify the transaction boundary and run the documented recovery procedure before retrying safely.`,
        scope: { visibility: 'project' },
      }, {
        idFactory: () => `bulk-${String(index).padStart(3, '0')}`,
        now: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
    }

    let cursor: string | undefined;
    let seen = 0;
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const page = await curateMemoryCandidates(database, { allWorkspaces: true, limit: 50, ...(cursor === undefined ? {} : { cursor }) });
      assert.equal(page.totalApproximate, 501);
      assert.equal(page.candidates.length, 50);
      assert.ok(page.nextCursor);
      seen += page.candidates.length;
      cursor = page.nextCursor ?? undefined;
    }
    assert.equal(seen, 500);
    if (cursor === undefined) throw new Error('Expected a cursor after 500 candidates');
    const finalPage = await curateMemoryCandidates(database, { allWorkspaces: true, limit: 1, cursor });
    assert.equal(finalPage.candidates.length, 1);
    assert.equal(finalPage.nextCursor, null);
    assert.equal(finalPage.totalApproximate, 501);
  } finally {
    database.close();
  }
});
