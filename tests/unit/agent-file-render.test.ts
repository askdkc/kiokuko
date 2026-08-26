import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BEGIN_MARKER, END_MARKER } from '../../src/agent-file/managed-block.js';
import { renderAgentFile, renderManagedBlock } from '../../src/agent-file/render.js';
import { KiokukoError } from '../../src/errors.js';

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

  assert.match(rendered, /<!-- kiokuko-template-version: 8 -->/);
  assert.match(rendered, /task_prepare/);
  assert.match(rendered, /`Array<\{kind:'skill'\|'mcp_tool';name:string;description\?:string\}>`/u);
  assert.match(rendered, /Every descriptor must include its kind and canonical name/u);
  assert.match(rendered, /bounded opaque `requestId`/);
  assert.match(rendered, /Use a new ID for every new logical request/);
  assert.match(rendered, /Reuse an ID only for an exact transport retry; changed bound input under the same ID is a conflict/);
  assert.match(rendered, /task_answer/);
  assert.match(rendered, /memory_checkpoint/);
  assert.match(rendered, /curator_check/);
  assert.match(rendered, /curator_globalize/);
  assert.match(rendered, /Akinator hypotheses/);
  assert.match(rendered, /untrusted advisory data/);
  assert.match(rendered, /memory-reasoning/);
  assert.match(rendered, /Inspect `nextAction` after every `task_prepare` and `task_answer` response/);
  assert.match(rendered, /`required_capability_unavailable` is a hard stop/);
  assert.match(rendered, /Do not continue through `catalog_similarity`, legacy instructions, external Skill discovery, fetched skills, or any other fallback/);
  assert.match(rendered, /Availability alone is not compliance: read that Skill before modifying code/);
  assert.match(rendered, /convert recalled claims that affect the task into verified premises, falsifiable invariants, concrete counterexamples, and regression tests/);
  assert.match(rendered, /Call `task_answer` with that run ID, the same capability catalog, and the same context budget/);
  assert.match(rendered, /When `runId` is supplied, the run must be active/);
  assert.match(rendered, /Do not call `memory_checkpoint` while `task_prepare` or `task_answer` reports `needs_answer`/);
  assert.match(rendered, /complete the required `task_answer` loop first/);
  assert.match(rendered, /successful terminal checkpoint is allowed at most once per logical request/);
  assert.match(rendered, /rejected precondition does not count as that successful checkpoint/);
  assert.match(rendered, /rejected precondition .*may be retried only after the indicated run-state change/);
  assert.doesNotMatch(rendered, /Call `memory_checkpoint` at most once for the current user request/);
  assert.match(rendered, /unavailable before a non-trivial build\/debug request can obtain its Kiokuko policy, stop and report/);
  assert.match(rendered, /For such a request, repository-only continuation is allowed only after the policy establishes that no Kiokuko memory was delivered or used/);
  assert.doesNotMatch(rendered, /MCP tools are unavailable[^.]*continue from repository evidence/iu);
  assert.match(rendered, /candidate/);
  assert.match(rendered, /at most one successful terminal `memory_checkpoint` for the current user request/);
  assert.match(rendered, /terminal for tool use/);
  assert.doesNotMatch(rendered, /server status|agent open|agent answer|agent events|agent close/);
  assert.doesNotMatch(rendered, /\/home\/|\/tmp\/|\.sqlite3?/);
  assert.doesNotMatch(rendered, /Authorization:\s*Bearer|capability token|server\.json|named-client/);
  assert.match(rendered, /passwords, API keys, access tokens, private keys, session cookies/);
});

test('managed markers must be exact standalone canonical lines', () => {
  for (const existing of [
    `human ${BEGIN_MARKER}\n${END_MARKER}\n`,
    `  ${BEGIN_MARKER}\n${END_MARKER}\n`,
    `${BEGIN_MARKER}\nprose ${END_MARKER}\n`,
  ]) {
    assert.throws(
      () => renderAgentFile(existing, {
        repositoryId: 'repo-fixture',
        workspace: 'project:fixture',
        cliCommand: 'kiokuko',
      }),
      (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
    );
  }
});

test('agent renderer rejects identity injection before interpolation', () => {
  assert.throws(
    () => renderManagedBlock({
      repositoryId: 'repo`injected',
      workspace: 'project:fixture',
      cliCommand: 'kiokuko',
    }),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
});
