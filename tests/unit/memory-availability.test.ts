import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderManagedBlock } from '../../src/agent-file/render.js';
import { renderGlobalInstructions } from '../../src/setup/render.js';
import { loadBundledStandardSkillFiles, hostSkillFile } from '../../src/setup/standard-skills.js';
import { CHATGPT_MEMORY_POLICY } from '../../src/chatgpt/memory-policy.js';
import { chatgptToolError } from '../../src/mcp/chatgpt-contract.js';

function assertAbsentServerFallback(text: string) {
  assert.match(text, /MCP server[^.]*missing/u);
  assert.match(text, /continue the user.s task/u);
  assert.match(text, /Never require installation, reconnection or repeated retries/u);
  assert.match(text, /never invent recalled content, a save receipt or verification/u);
}

test('missing-server fallback reaches project, global, ChatGPT and independently installed Skills', async () => {
  assertAbsentServerFallback(renderManagedBlock({repositoryId:'repo-fixture',workspace:'project:fixture',cliCommand:'kiokuko'}));
  for (const host of ['codex', 'opencode', 'claude', 'hermes']) {
    assertAbsentServerFallback(renderGlobalInstructions('', host).content);
  }
  assertAbsentServerFallback(CHATGPT_MEMORY_POLICY.instructions);
  for (const file of (await loadBundledStandardSkillFiles()).filter(file => file.relativePath === 'SKILL.md')) {
    assertAbsentServerFallback(file.content);
    assertAbsentServerFallback(hostSkillFile(file, 'codex').content);
  }
});

test('standalone completion guidance scopes MCP verification to optional memory records', () => {
  const completion=readFileSync(new URL('../../skills/one-shot-software-completion/SKILL.md',import.meta.url),'utf8');
  assert.match(completion,/For an optional memory record[^.]*task_verification_define/su);
  assert.match(completion,/Missing memory verification tools do not block coding, tests or the final answer/u);
});

test('ChatGPT errors preserve standard error envelopes and distinguish memory failure from task blocking', () => {
  for (const code of ['SERVICE_UNAVAILABLE','TOOL_ERROR','BACKPRESSURE','POLICY_REQUIRED','POLICY_VERSION_MISMATCH'] as const) {
    const response=chatgptToolError(code);
    const fields=JSON.parse(response.content[0]!.text);
    assert.equal(response.isError,true);
    assert.equal('structuredContent' in response,false);
    assert.equal(fields.code,code);
    assert.equal(fields.workMayContinue,true);
    assert.match(fields.message,/continue the user.s task/u);
    assert.match(fields.message,/does not confirm a memory recall or save/u);
  }
  for (const code of ['SECURITY_REJECTION','VALIDATION_ERROR','CONFLICT','NOT_FOUND'] as const) {
    assert.equal(JSON.parse(chatgptToolError(code).content[0]!.text).workMayContinue,undefined);
  }
});
