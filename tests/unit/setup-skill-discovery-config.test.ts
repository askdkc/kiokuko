import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'jsonc-parser';
import { KiokukoError } from '../../src/errors.js';
import { renderOpenCodeConfig } from '../../src/setup/opencode-config.js';
import { renderCodexMcpConfig } from '../../src/setup/render.js';

test('Codex setup writes and preserves the external Skill discovery mode', () => {
  const official = renderCodexMcpConfig('', 'kiokuko');
  assert.match(official.content, /env = \{ KIOKUKO_SKILL_DISCOVERY = "official" \}/u);

  const community = renderCodexMcpConfig(official.content, 'kiokuko', 'community');
  assert.match(community.content, /KIOKUKO_SKILL_DISCOVERY = "community"/u);
  assert.equal(renderCodexMcpConfig(community.content).action, 'unchanged');

  const disabled = renderCodexMcpConfig(community.content, 'kiokuko', 'off');
  assert.match(disabled.content, /KIOKUKO_SKILL_DISCOVERY = "off"/u);

  const relocated = renderCodexMcpConfig(disabled.content, '/opt/kiokuko', 'community');
  assert.equal(relocated.action, 'updated');
  assert.match(relocated.content, /command = "\/opt\/kiokuko"/u);
  assert.equal(renderCodexMcpConfig(relocated.content, '/opt/kiokuko').action, 'unchanged');
});

test('Codex setup rejects non-canonical marked blocks instead of migrating them', () => {
  const canonical = renderCodexMcpConfig('model = "keep"\n').content;
  const managedBlock = canonical.slice(canonical.indexOf('# BEGIN KIOKUKO MCP'));
  const variants = [
    canonical.replace('env = { KIOKUKO_SKILL_DISCOVERY = "official" }\n', ''),
    canonical.replace('args = ["mcp"]', 'args = ["serve"]'),
    canonical.replace('enabled = true', 'enabled = false'),
    canonical.replace('command = "kiokuko"', 'command = ""'),
    canonical.replace('env = { KIOKUKO_SKILL_DISCOVERY = "official" }', 'env = { KIOKUKO_SKILL_DISCOVERY = "official", PATH = "/custom" }'),
    canonical.replace('enabled = true', 'enabled = true\ncustom = true'),
    canonical.replace('# Managed by `kiokuko setup`.', '# copied markers around a human wrapper'),
    canonical.replace('command = "kiokuko"\nargs = ["mcp"]', 'command = "human-wrapper"\nargs = ["run", "kiokuko"]'),
    `${canonical}${managedBlock}`,
    canonical.replace('# BEGIN KIOKUKO MCP', '# human prefix # BEGIN KIOKUKO MCP'),
  ];

  for (const existing of variants) {
    assert.throws(
      () => renderCodexMcpConfig(existing, '/new/path'),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'CONFLICT'
        && !error.message.includes('/new/path'),
    );
  }
});

test('Codex setup rejects invalid requested state without rendering it', () => {
  assert.throws(
    () => renderCodexMcpConfig('', '   '),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => renderCodexMcpConfig('', 'kiokuko', 'invalid' as never),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
});

test('Codex setup validates complete TOML and rejects alternate Kiokuko identities', () => {
  assert.doesNotThrow(() => renderCodexMcpConfig([
    'model = "gpt-5"',
    'features = ["one", "two"]',
    '[projects."/tmp/example"]',
    'trust_level = "trusted"',
    '',
  ].join('\n')));
  for (const source of [
    '[a]\na.b = 1\n',
    '[a.b]\nx = 1\n[a]\ny = 2\n',
    '[[a]]\nx = 1\n[[a]]\nx = 2\n',
  ]) assert.doesNotThrow(() => renderCodexMcpConfig(source));
  assert.throws(
    () => renderCodexMcpConfig('model = ["unterminated"\n'),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
  for (const source of [
    'a = 1\n[a]\nb = 2\n',
    'a = { b = 1 }\n[a]\nc = 2\n',
    'a.b = 1\n[a]\nc = 2\n',
    '[a]\nb.c = 1\n[a.b]\nd = 2\n',
    'a = 1\na.b = 2\n',
    'a.b = 1\na = 2\n',
    'a = { b = 1, b.c = 2 }\n',
    'a = []\n[[a]]\nb = 2\n',
    '[[a]]\nb = 1\n[a]\nc = 2\n',
    'x = """\\q"""\n',
    'x = 1979-99-99\n',
    'x = 1979-02-29\n',
  ]) {
    assert.throws(
      () => renderCodexMcpConfig(source),
      (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
    );
  }
  for (const source of [
    'mcp_servers.kiokuko.command = "human"\n',
    'mcp_servers = { kiokuko = { command = "human" } }\n',
    '["mcp_servers"."kiokuko"]\ncommand = "human"\n',
  ]) {
    assert.throws(
      () => renderCodexMcpConfig(source),
      (error: unknown) => error instanceof KiokukoError && error.code === 'CONFLICT',
    );
  }
});

test('OpenCode setup rejects duplicate JSONC keys', () => {
  assert.throws(
    () => renderOpenCodeConfig('{"mcp":{},"mcp":{}}\n'),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
});

test('OpenCode setup rejects present empty JSONC instead of treating it as a missing file', () => {
  for (const source of ['', ' \t\r\n']) {
    assert.throws(
      () => renderOpenCodeConfig(source),
      (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
    );
  }
});

test('OpenCode setup writes and preserves the external Skill discovery mode', () => {
  const existing = '{\n  // keep\n  "theme": "dark"\n}\n';
  const community = renderOpenCodeConfig(existing, 'kiokuko', 'community');
  const parsed = parse(community.content) as {
    theme: string;
    mcp: { kiokuko: { environment: { KIOKUKO_SKILL_DISCOVERY: string } } };
  };
  assert.equal(parsed.theme, 'dark');
  assert.equal(parsed.mcp.kiokuko.environment.KIOKUKO_SKILL_DISCOVERY, 'community');
  assert.match(community.content, /\/\/ keep/u);
  assert.equal(renderOpenCodeConfig(community.content).action, 'unchanged');

  const updated = renderOpenCodeConfig(community.content, '/usr/local/bin/kiokuko');
  const updatedConfig = parse(updated.content) as {
    theme: string;
    mcp: { kiokuko: { command: string[] } };
  };
  assert.equal(updated.action, 'updated');
  assert.equal(updatedConfig.theme, 'dark');
  assert.deepEqual(updatedConfig.mcp.kiokuko.command, ['/usr/local/bin/kiokuko', 'mcp']);
});

test('OpenCode setup rejects non-canonical or modified kiokuko servers as conflicts', () => {
  const canonical = parse(renderOpenCodeConfig('{}\n').content) as {
    mcp: { kiokuko: Record<string, unknown> };
  };
  const variants: Record<string, unknown>[] = [
    { ...canonical.mcp.kiokuko, extra: true },
    { ...canonical.mcp.kiokuko, type: 'remote' },
    { ...canonical.mcp.kiokuko, command: ['human-wrapper', 'serve'] },
    { ...canonical.mcp.kiokuko, command: ['kiokuko', 'mcp', '--custom'] },
    { ...canonical.mcp.kiokuko, enabled: false },
    { ...canonical.mcp.kiokuko, environment: { KIOKUKO_SKILL_DISCOVERY: 'official', PATH: '/custom' } },
    { ...canonical.mcp.kiokuko, environment: { KIOKUKO_SKILL_DISCOVERY: 'invalid' } },
  ];

  for (const kiokuko of variants) {
    const existing = `${JSON.stringify({ theme: 'keep', mcp: { other: { command: ['keep'] }, kiokuko } }, null, 2)}\n`;
    assert.throws(
      () => renderOpenCodeConfig(existing, '/new/kiokuko'),
      (error: unknown) => error instanceof KiokukoError
        && error.code === 'CONFLICT'
        && !error.message.includes('/new/kiokuko'),
    );
  }
});

test('OpenCode setup rejects invalid MCP container and requested state without rewriting config', () => {
  for (const existing of ['{"mcp":[]}\n', '{"mcp":"custom"}\n']) {
    assert.throws(
      () => renderOpenCodeConfig(existing),
      (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
    );
  }
  assert.throws(
    () => renderOpenCodeConfig('{}\n', ''),
    (error: unknown) => error instanceof KiokukoError && error.code === 'VALIDATION_ERROR',
  );
});
