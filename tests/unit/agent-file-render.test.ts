import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BEGIN_MARKER, END_MARKER } from '../../src/agent-file/managed-block.js';
import { renderManagedBlock } from '../../src/agent-file/render.js';

test('template placeholders produce exactly the programmatic managed block', async () => {
  const values = {
    repositoryId: 'repo-fixture',
    workspace: 'workspace-fixture',
    cliCommand: 'kiokuko' as const,
  };
  const template = await readFile(new URL('../../templates/AGENT.md', import.meta.url), 'utf8');
  const start = template.indexOf(BEGIN_MARKER);
  const end = template.indexOf(END_MARKER, start) + END_MARKER.length;
  const fixtureTemplate = template
    .slice(start, end)
    .replaceAll('{{REPOSITORY_ID}}', values.repositoryId)
    .replaceAll('{{WORKSPACE}}', values.workspace)
    .replaceAll('{{CLI_COMMAND}}', values.cliCommand);

  assert.equal(fixtureTemplate.replace(/\r\n/g, '\n'), renderManagedBlock(values));
});

test('renders the server-centered generic-agent lifecycle without legacy commands or secrets', () => {
  const rendered = renderManagedBlock({
    repositoryId: 'repo-fixture',
    workspace: 'workspace-fixture',
    cliCommand: 'kiokuko',
  });

  assert.match(rendered, /kiokuko server status --json/);
  assert.match(rendered, /<!-- kiokuko-template-version: 2 -->/);
  assert.match(rendered, /If the server status or agent open command fails/);
  assert.match(rendered, /kiokuko agent open --workspace "workspace-fixture" --client generic --task "<task description>" --json/);
  assert.match(rendered, /kiokuko agent answer "<run-id>" --question-id "<question-id>" --value "<answer>" --json/);
  assert.match(rendered, /kiokuko agent events "<run-id>" --input-json - --json/);
  assert.match(rendered, /kiokuko agent checkpoint "<run-id>" --input-json - --json/);
  assert.match(rendered, /kiokuko agent close "<run-id>" --input-json - --json/);
  assert.match(rendered, /kiokuko agent feedback "<run-id>" --input-json - --json/);
  assert.match(rendered, /kiokuko agent promote "<run-id>" --input-json - --json/);
  assert.match(rendered, /needs_answer/);
  assert.match(rendered, /ready|exhausted/);
  assert.match(rendered, /untrusted stored data/);
  assert.match(rendered, /server recommendation/);
  assert.match(rendered, /candidate/);
  assert.doesNotMatch(rendered, /(?:^|\s)guide(?:\s|$)|(?:^|\s)recall(?:\s|$)/);
  assert.doesNotMatch(rendered, /\/home\/|\/tmp\/|\.sqlite3?/);
  assert.doesNotMatch(rendered, /Authorization:\s*Bearer|capability token|server\.json|named-client/);
  assert.match(rendered, /passwords, API keys, access tokens, private keys, session cookies/);
});
