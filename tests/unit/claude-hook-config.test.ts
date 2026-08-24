import assert from 'node:assert/strict';
import test from 'node:test';
import { KiokukoError } from '../../src/errors.js';
import { renderClaudePromptHookConfig } from '../../src/setup/claude-hook-config.js';

function managedHandlers(value: unknown): Array<Record<string, unknown>> {
  const settings = value as { hooks: { UserPromptSubmit: Array<{ hooks: Array<Record<string, unknown>> }> } };
  return settings.hooks.UserPromptSubmit.flatMap((group) => group.hooks).filter((handler) => (
    handler.type === 'mcp_tool' && handler.server === 'kiokuko' && handler.tool === 'claude_prompt_context'
  ));
}

test('creates the Claude UserPromptSubmit MCP hook in an empty settings file', () => {
  const rendered = renderClaudePromptHookConfig(undefined);
  const settings = JSON.parse(rendered.content) as Record<string, unknown>;
  assert.equal(rendered.action, 'created');
  assert.equal(managedHandlers(settings).length, 1);
  assert.deepEqual(managedHandlers(settings)[0], {
    type: 'mcp_tool',
    server: 'kiokuko',
    tool: 'claude_prompt_context',
    input: { prompt: '${prompt}', cwd: '${cwd}', sessionId: '${session_id}' },
    timeout: 5,
    statusMessage: 'Kiokuko: recalling relevant memory',
  });
});

test('preserves existing settings and non-Kiokuko hooks while deduplicating and normalizing the managed hook', () => {
  const existing = JSON.stringify({
    permissions: { allow: ['Read'] },
    plugins: { enabled: true },
    hooks: {
      UserPromptSubmit: [
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo keep' }, { type: 'mcp_tool', server: 'kiokuko', tool: 'claude_prompt_context', timeout: 1 }] },
        { hooks: [{ type: 'mcp_tool', server: 'kiokuko', tool: 'claude_prompt_context', input: { prompt: 'old' } }] },
      ],
    },
  }, null, 2);
  const rendered = renderClaudePromptHookConfig(existing);
  const settings = JSON.parse(rendered.content) as Record<string, unknown> & { permissions: unknown; plugins: unknown; hooks: unknown };
  assert.equal(rendered.action, 'updated');
  assert.deepEqual(settings.permissions, { allow: ['Read'] });
  assert.deepEqual(settings.plugins, { enabled: true });
  assert.equal(managedHandlers(settings).length, 1);
  assert.equal(JSON.stringify(settings).includes('echo keep'), true);
  assert.equal(renderClaudePromptHookConfig(rendered.content).action, 'unchanged');
});

test('rejects malformed settings and invalid hook array shapes', () => {
  for (const source of [
    '{"permissions":',
    '{"hooks": []}',
    '{"hooks":{"UserPromptSubmit":{}}}',
    '{"hooks":{"UserPromptSubmit":[{"hooks":{}}]}}',
    '{"hooks":{"UserPromptSubmit":[{"hooks":[null]}]}}',
  ]) {
    assert.throws(() => renderClaudePromptHookConfig(source), (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR');
  }
});

test('keeps CRLF and the existing indentation when adding the hook', () => {
  const existing = '{\r\n    "permissions": {\r\n        "allow": ["Read"]\r\n    }\r\n}\r\n';
  const rendered = renderClaudePromptHookConfig(existing);
  assert.equal(rendered.content.includes('\r\n'), true);
  assert.equal(rendered.content.includes('\n"'), false);
  assert.match(rendered.content, /\r\n    "hooks"/u);
  assert.equal(managedHandlers(JSON.parse(rendered.content)).length, 1);
});
