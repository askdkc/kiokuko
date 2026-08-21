import assert from 'node:assert/strict';
import test from 'node:test';
import { KiokukoError } from '../../src/errors.js';
import { renderClaudeConfig } from '../../src/setup/claude-config.js';

test('adds a Claude Code user-scope stdio MCP server while preserving other JSON fields', () => {
  const existing = '{\n  "theme": "dark",\n  "mcpServers": {\n    "other": { "type": "http", "url": "https://example.test/mcp" }\n  }\n}\n';
  const rendered = renderClaudeConfig(existing, '/opt/kiokuko');
  const parsed = JSON.parse(rendered.content) as {
    theme: string;
    mcpServers: Record<string, unknown> & { kiokuko: unknown };
  };

  assert.equal(rendered.action, 'updated');
  assert.equal(parsed.theme, 'dark');
  assert.deepEqual(parsed.mcpServers.other, { type: 'http', url: 'https://example.test/mcp' });
  assert.deepEqual(parsed.mcpServers.kiokuko, {
    type: 'stdio',
    command: '/opt/kiokuko',
    args: ['mcp'],
    env: {},
  });
  assert.equal(renderClaudeConfig(rendered.content, '/opt/kiokuko').action, 'unchanged');
});

test('rejects malformed Claude JSON instead of overwriting it', () => {
  assert.throws(
    () => renderClaudeConfig('{ "theme": }'),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
});
