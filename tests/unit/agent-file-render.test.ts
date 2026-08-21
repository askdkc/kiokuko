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
  const template = await readFile(new URL('../../templates/AGENTS.md', import.meta.url), 'utf8');
  const start = template.indexOf(BEGIN_MARKER);
  const end = template.indexOf(END_MARKER, start) + END_MARKER.length;
  const fixtureTemplate = template
    .slice(start, end)
    .replaceAll('{{REPOSITORY_ID}}', values.repositoryId)
    .replaceAll('{{WORKSPACE}}', values.workspace)
    .replaceAll('{{CLI_COMMAND}}', values.cliCommand);

  assert.equal(fixtureTemplate.replace(/\r\n/g, '\n'), renderManagedBlock(values));
});

test('renders the MCP-centered memory lifecycle without legacy gateway commands or secrets', () => {
  const rendered = renderManagedBlock({
    repositoryId: 'repo-fixture',
    workspace: 'workspace-fixture',
    cliCommand: 'kiokuko',
  });

  assert.match(rendered, /<!-- kiokuko-template-version: 5 -->/);
  assert.match(rendered, /task_prepare/);
  assert.match(rendered, /task_answer/);
  assert.match(rendered, /memory_checkpoint/);
  assert.match(rendered, /untrusted advisory data/);
  assert.match(rendered, /candidate/);
  assert.match(rendered, /at most once for the current user request/);
  assert.match(rendered, /terminal for tool use/);
  assert.doesNotMatch(rendered, /server status|agent open|agent answer|agent events|agent close/);
  assert.doesNotMatch(rendered, /\/home\/|\/tmp\/|\.sqlite3?/);
  assert.doesNotMatch(rendered, /Authorization:\s*Bearer|capability token|server\.json|named-client/);
  assert.match(rendered, /passwords, API keys, access tokens, private keys, session cookies/);
});
