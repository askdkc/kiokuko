import assert from 'node:assert/strict';
import test from 'node:test';
import { getHermesConfigPath } from '../../src/config/paths.js';
import { renderHermesConfig } from '../../src/setup/hermes-config.js';

function errorIdentity(callback: () => unknown): { code: string | undefined; message: string | undefined } {
  try {
    callback();
    return { code: undefined, message: undefined };
  } catch (error) {
    const typed = error as { code?: string; message?: string };
    return { code: typed.code, message: typed.message };
  }
}

test('renders Hermes MCP config while preserving comments, other servers, and top-level values', () => {
  const existing = [
    '# preserve this top-level comment',
    'model:',
    '  default: test-model',
    'mcp_servers:',
    '  # preserve this other server',
    '  other:',
    '    command: other-server',
    '    args: [serve]',
    '',
  ].join('\n');

  const result = renderHermesConfig(existing, '/opt/kiokuko');

  assert.equal(result.action, 'updated');
  assert.match(result.content, /preserve this top-level comment/);
  assert.match(result.content, /default: test-model/);
  assert.match(result.content, /preserve this other server/);
  assert.match(result.content, /other-server/);
  assert.match(result.content, /Managed by `kiokuko setup`\./);
  assert.match(result.content, /command: \/opt\/kiokuko/);
  assert.match(result.content, /- mcp/);
});

test('replays an exactly managed Hermes config unchanged', () => {
  const first = renderHermesConfig('model: test\n');
  const second = renderHermesConfig(first.content);

  assert.equal(second.action, 'unchanged');
  assert.equal(second.content, first.content);
});

test('rejects invalid YAML and non-mapping Hermes config shapes with fixed validation errors', () => {
  for (const existing of [
    'model: [unterminated',
    '- not-a-mapping\n',
    'mcp_servers: []\n',
    'mcp_servers: not-a-mapping\n',
  ]) {
    const identity = errorIdentity(() => renderHermesConfig(existing));
    assert.equal(identity.code, 'VALIDATION_ERROR');
    assert.equal(identity.message?.includes(existing), false);
    assert.equal(identity.message?.includes('/private/hermes/config.yaml'), false);
  }
});

test('rejects an unmanaged or differently managed kiokuko server as a conflict', () => {
  const unmanaged = [
    'mcp_servers:',
    '  kiokuko:',
    '    command: another-tool',
    '    args: [mcp]',
    '',
  ].join('\n');
  const unmanagedIdentity = errorIdentity(() => renderHermesConfig(unmanaged));
  assert.equal(unmanagedIdentity.code, 'CONFLICT');

  const managed = renderHermesConfig('model: test\n').content;
  const differentIdentity = errorIdentity(() => renderHermesConfig(managed, 'different-kiokuko'));
  assert.equal(differentIdentity.code, 'CONFLICT');

  const extendedIdentity = errorIdentity(() => renderHermesConfig(
    managed.replace('    args:\n      - mcp\n', '    args:\n      - mcp\n    enabled: false\n'),
  ));
  assert.equal(extendedIdentity.code, 'CONFLICT');
});

test('preserves CRLF line endings when updating Hermes config', () => {
  const existing = 'model: test\r\nmcp_servers:\r\n  other:\r\n    command: other\r\n';
  const result = renderHermesConfig(existing);

  assert.match(result.content, /\r\n/);
  assert.equal(result.content.replaceAll('\r\n', '').includes('\n'), false);
});

test('resolves a profile-shaped Windows HERMES_HOME without consulting the sticky root', async () => {
  const configPath = await getHermesConfigPath({
    platform: 'win32',
    env: { HERMES_HOME: 'C:\\Users\\tester\\hermes\\profiles\\main' },
  });

  assert.equal(configPath, 'C:\\Users\\tester\\hermes\\profiles\\main\\config.yaml');
});
