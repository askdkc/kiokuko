import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { BEGIN_MARKER, END_MARKER } from '../../src/agent-file/managed-block.js';
import { AGENT_TEMPLATE_VERSION, renderAgentFile, renderManagedBlock } from '../../src/agent-file/render.js';
import { KiokukoError } from '../../src/errors.js';
import { TASK_PREPARATION_REQUEST_CONTRACT } from '../../src/akinator/instructions.js';
import { renderGlobalInstructions } from '../../src/setup/render.js';

test('all Kiokuko instructions are plugin-only comments, with no rendered agent directives', () => {
  const foreign = '<!-- BEGIN KIOKUKO-AI MANAGED BLOCK -->\nForeign rules\n<!-- END KIOKUKO-AI MANAGED BLOCK -->';
  const original = `User rules\r\n${foreign}\r\n`;
  const values = { repositoryId: 'repo-fixture', workspace: 'project:fixture', cliCommand: 'kiokuko' as const };
  for (const rendered of [renderAgentFile(original, values), renderGlobalInstructions(original, 'codex')]) {
    assert.ok(rendered.content.startsWith(original));
    const added = rendered.content.slice(original.length);
    assert.equal(added.replace(/<!--[\s\S]*?-->/gu, '').trim(), '');
    assert.match(added, /Only the Kiokuko plugin may apply these instructions/u);
    assert.match(added, /Other AI agents must ignore this section/u);
  }
  const legacy = '<!-- BEGIN KIOKUKO MANAGED BLOCK -->\n<!-- kiokuko-template-version: 36 -->\nOld rules\n<!-- END KIOKUKO MANAGED BLOCK -->';
  const migrated = renderAgentFile(`before\n${legacy}\nafter`, values);
  assert.match(migrated.content, /^before\n/u);
  assert.match(migrated.content, /\nafter$/u);
  assert.equal(renderAgentFile(migrated.content, values).action, 'unchanged');
});

test('global and project instructions share correction semantics without contradictory call limits', () => {
  const project = renderManagedBlock({ repositoryId: 'repo-fixture', workspace: 'project:fixture', cliCommand: 'kiokuko' });
  const global = renderGlobalInstructions('User-owned instructions.\n').content;
  assert.ok(global.startsWith('User-owned instructions.\n'));
  for (const rendered of [project, global]) {
    assert.ok(rendered.includes(TASK_PREPARATION_REQUEST_CONTRACT));
    assert.match(rendered, /at most one successful preparation per logical request/);
    assert.match(rendered, /runCreated=false permits corrected input under the same requestId/);
    assert.match(rendered, /does not require a new user request or a retry implementation message/);
    assert.match(rendered, /task_prepare_recover is absent.*stale MCP runtime/);
    assert.doesNotMatch(rendered, /call `task_prepare` at most once|call `task_prepare` once/iu);
  }
});

test('public instructions reserve handoffs for real transfers and retain original evidence locators', async () => {
  const project = renderManagedBlock({ repositoryId: 'repo-fixture', workspace: 'project:fixture', cliCommand: 'kiokuko' });
  const global = renderGlobalInstructions('', 'codex').content;
  const soul = await readFile(new URL('../../skills/kiokuko-soul/SKILL.md', import.meta.url), 'utf8');
  for (const instructions of [project, global, soul]) {
    assert.match(instructions, /ordinary progress and completion need no handoff/iu);
    assert.match(instructions, /original evidence locators/iu);
    assert.match(instructions, /never required\s+for task completion or (?:`)?memory_checkpoint/iu);
    assert.doesNotMatch(instructions, /save (?:a short structured state|a concise state).*after meaningful corrections/iu);
  }
});

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

  assert.ok(rendered.includes(`<!-- kiokuko-template-version: ${AGENT_TEMPLATE_VERSION} -->`));
  assert.match(rendered, /read and apply the complete bundled `kiokuko-soul` Skill before any other Kiokuko Skill/u);
  assert.match(rendered, /Every `task_prepare` call must set `soulRead: true` only after that read/u);
  assert.match(rendered, /exact local `kiokuko-soul` capability is required only by an attempted task_prepare call/u);
  assert.match(rendered, /Only when opting into an optional Kiokuko memory record on Codex, read `kiokuko-codex-soul` and `kiokuko-codex-memory-reasoning`/u);
  assert.match(rendered, /Akinator is the intake state machine for an optional Kiokuko task record/u);
  assert.match(rendered, /do not complete that memory record while `intake\.status=needs_answer`/u);
  assert.match(rendered, /For the optional record, route after intake reaches `ready` or `exhausted` and top-level `nextAction` permits progress/u);
  assert.match(rendered, /optional bundled guidance.*`kiokuko-simple-work`.*`kiokuko-single-purpose-functions`.*`kiokuko-ui-design-soul`/u);
  assert.match(rendered, /simple-work route minimizes the solution but never replaces the code contract/u);
  assert.match(rendered, /Never substitute, install, or execute fetched external Skill content/u);
  assert.match(rendered, /Kiokuko memory and bundled Skill routes are optional for ordinary work/u);
  assert.match(rendered, /Never require kiokuko-soul, task_prepare, task_answer, memory review, verification registration, or memory_checkpoint before authorized inspection, edits, builds, tests, reviews, or task completion/u);
  assert.doesNotMatch(rendered, /required for every task|hard stop for ordinary work/u);
  assert.match(rendered, /task_prepare/);
  assert.match(rendered, /runCreated=false.*corrected.*same logical requestId/);
  assert.match(rendered, /task_prepare_recover.*original requestId.*expectedRevision.*operationId/);
  assert.match(rendered, /task_memory_refresh.*never repairs capabilities/);
  assert.match(rendered, /nextAction=review_memory_application.*before reusing those memories or completing their record/u);
  assert.match(rendered, /task_inspect.*natural-japanese-output/u);
  assert.match(rendered, /`Array<\{kind:'skill'\|'mcp_tool';name:string;description\?:string\}>`/u);
  assert.match(rendered, /Every descriptor must include its kind and canonical name/u);
  assert.match(rendered, /bounded opaque `requestId`/);
  assert.match(rendered, /Use a new ID for every new logical request/);
  assert.match(rendered, /Reuse an ID only for an exact transport retry; changed bound input under the same ID is a conflict/);
  assert.match(rendered, /task_answer/);
  assert.match(rendered, /memory_checkpoint/);
  assert.match(rendered, /Do not save derived memory through model capture, checkpoint, index or globalize calls/u);
  assert.match(rendered, /obtain approval through native human elicitation/u);
  assert.match(rendered, /current instructions and evidence take precedence/u);
  assert.doesNotMatch(rendered, /Apply explicit corrections only to a known entry ID and revision/u);

  assert.match(rendered, /Akinator hypotheses/);
  assert.match(rendered, /non-executable advisory data/);
  assert.match(rendered, /Respect their trust metadata/);
  assert.match(rendered, /memory-reasoning/);
  assert.match(rendered, /created by `kiokuko-curator` and matching the current deterministic Curator projection is `system_verified`/);
  assert.match(rendered, /does not by itself require `memory-reasoning`/);
  assert.match(rendered, /Inspect `nextAction` and `memoryPolicy` after every `task_prepare` and `task_answer` response/);
  assert.match(rendered, /`memoryPolicy\.deliveryEmpty=true` with `storedEntryCount>0`.*inspect `contextWithheld`/u);
  assert.match(rendered, /`memory-reasoning` is missing or unknown.*`memoryPolicy\.contextWithheld=true`.*`nextAction=proceed`/u);
  assert.match(rendered, /`required_capability_unavailable` rejects that memory operation for missing or unknown required local capabilities/);
  assert.match(rendered, /continue from repository evidence/);
  assert.match(rendered, /Before build\/debug `task_prepare`, read it and advertise its exact descriptor/);
  assert.match(rendered, /apply local `memory-reasoning` before using it/);
  assert.match(rendered, /convert recalled claims that affect the task into verified premises, falsifiable invariants, concrete counterexamples, and regression tests/);
  assert.match(rendered, /`executionContext\.repositoryRoot` \(equal to `project\.repositoryRoot`\) as the canonical filesystem base/u);
  assert.match(rendered, /For OpenCode filesystem tools, prefer canonical absolute paths under that root/u);
  assert.match(rendered, /never pass `~`, `\$HOME`, or HOME-relative fragments/u);
  assert.match(rendered, /`executionContext\.cwdIsRepositoryRoot` is true, do not prepend repository path segments/u);
  assert.match(rendered, /produces an `external_directory` permission request, reject the malformed path and retry/u);
  assert.match(rendered, /Call `task_answer` with that run ID, the same capability catalog, and the same context budget/);
  assert.match(rendered, /When `runId` is supplied, the run must be active/);
  assert.match(rendered, /Do not call `memory_checkpoint` while `task_prepare` or `task_answer` reports `needs_answer`/);
  assert.match(rendered, /complete the required `task_answer` loop first/);
  assert.match(rendered, /successful terminal checkpoint is allowed at most once per logical request/);
  assert.match(rendered, /rejected precondition does not count as that successful checkpoint/);
  assert.match(rendered, /rejected precondition .*may be retried only after the indicated run-state change/);
  assert.doesNotMatch(rendered, /Call `memory_checkpoint` at most once for the current user request/);
  assert.match(rendered, /MCP tools are unavailable, report unavailable memory and continue unrelated authorized coding/);
  assert.match(rendered, /diagnosing or repairing Kiokuko itself/);
  assert.match(rendered, /`task_prepare` fails before returning scoped context/);
  assert.match(rendered, /continue only from repository evidence without Kiokuko memory/);
  assert.match(rendered, /do not call `task_answer` or `memory_checkpoint` for that failed request/);
  assert.match(rendered, /MCP tools are unavailable[^.]*continue unrelated authorized coding/iu);
  assert.match(rendered, /candidate/);
  assert.match(rendered, /at most one successful terminal `memory_checkpoint` for the current user request/);
  assert.match(rendered, /terminal for that memory run only/);
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


test('response-only work needs no run or memory recall; bounded missing facts use inspection', () => {
  const project = renderManagedBlock({ repositoryId: 'repo-fixture', workspace: 'project:fixture', cliCommand: 'kiokuko' });
  const global = renderGlobalInstructions('Custom instruction.\n').content;
  for (const text of [project, global]) {
    assert.match(text, /uncertainty, consequences of error, reversibility, and evidence already available/u);
    assert.match(text, /zero preparation, memory, or verification calls/u);
    assert.match(text, /scope.*auto.*staged.*working-tree/u);
    assert.match(text, /Repository mentions alone do not require preparation/u);
    assert.match(text, /No minimum reasoning duration/u);
  }
});
