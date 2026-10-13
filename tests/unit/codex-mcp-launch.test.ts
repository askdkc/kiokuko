import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renderCodexMcpConfig } from '../../src/setup/render.js';
import { validateCodexMcpRuntime } from '../../src/setup/codex-mcp-launch.js';

const currentRuntime = () => ({ node: process.execPath, script: '/fixture/kiokuko/dist/bin/kiokuko.js' });

test('omitted command preserves an existing absolute custom MCP launcher', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kiokuko-custom-launch-'));
  const custom = path.join(root, 'kiokuko');
  writeFileSync(custom, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const existing = renderCodexMcpConfig('', custom, 'community').content;
  const updated = renderCodexMcpConfig(existing, undefined, undefined, { defaultRuntime: () => assert.fail('An existing launcher must not resolve a new default') });
  assert.equal(updated.content, existing);
  assert.equal(updated.action, 'unchanged');
});

test('omitted command preserves legacy bare launcher and explicit override wins', () => {
  const existing = renderCodexMcpConfig('', 'kiokuko').content;
  assert.equal(renderCodexMcpConfig(existing).content, existing);
  const updated = renderCodexMcpConfig(existing, '/new/kiokuko');
  assert.ok(updated.content.includes('command = "/new/kiokuko"'));
  const explicitBare = renderCodexMcpConfig(updated.content, 'kiokuko');
  assert.ok(explicitBare.content.includes('command = "kiokuko"'));
});

test('new default pins Node and compiled CLI, and reruns preserve both paths', () => {
  const options = { defaultRuntime: currentRuntime };
  const created = renderCodexMcpConfig('', undefined, 'off', options);
  assert.ok(created.content.includes(`command = ${JSON.stringify(process.execPath)}`));
  assert.ok(created.content.includes('args = ["/fixture/kiokuko/dist/bin/kiokuko.js","mcp"]'));
  assert.match(created.content, /^required = true$/mu);
  const moved = { defaultRuntime: () => ({ node: '/new/node', script: '/new/kiokuko/dist/bin/kiokuko.js' }) };
  assert.equal(renderCodexMcpConfig(created.content, undefined, undefined, moved).content, created.content);
  const explicit = renderCodexMcpConfig(created.content, '/custom/kiokuko');
  assert.ok(explicit.content.includes('command = "/custom/kiokuko"\nargs = ["mcp"]'));
});

test('new pinned launcher runs with a PATH containing no Node or kiokuko', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kiokuko-mcp-launch-'));
  const script = path.join(root, 'dist', 'bin', 'kiokuko.js');
  mkdirSync(path.dirname(script), { recursive: true });
  const emptyPath = path.join(root, 'empty-bin');
  mkdirSync(emptyPath);
  writeFileSync(script, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n');
  const rendered = renderCodexMcpConfig('', undefined, undefined, { defaultRuntime: () => validateCodexMcpRuntime({ node: process.execPath, script }) });
  const command = JSON.parse(/^command = (.+)$/mu.exec(rendered.content)![1]!);
  const args = JSON.parse(/^args = (.+)$/mu.exec(rendered.content)![1]!);
  const launched = spawnSync(command, args, { cwd: root, env: { PATH: emptyPath }, encoding: 'utf8' });
  assert.equal(launched.error, undefined);
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(launched.stdout.trim(), '["mcp"]');
});

test('a new default refuses a missing compiled CLI or interpreter', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'kiokuko-mcp-missing-'));
  const script = path.join(root, 'dist', 'bin', 'kiokuko.js');
  const missing = { node: process.execPath, script };
  assert.throws(() => validateCodexMcpRuntime(missing), /compiled Kiokuko CLI is unavailable/);
  mkdirSync(path.dirname(script), { recursive: true });
  writeFileSync(script, 'console.log("ready");\n');
  assert.throws(() => validateCodexMcpRuntime({ node: path.join(root, 'absent-node'), script }), /compiled Kiokuko CLI is unavailable/);
  const existing = renderCodexMcpConfig('', '/keep/kiokuko').content;
  assert.equal(renderCodexMcpConfig(existing, undefined, undefined, { defaultRuntime: () => assert.fail('An existing launcher must not resolve an unavailable default') }).content, existing);
});

test('only canonical pinned arguments are accepted as managed launchers', () => {
  const canonical = renderCodexMcpConfig('', undefined, undefined, { defaultRuntime: currentRuntime }).content;
  for (const changed of [
    canonical.replace('["/fixture/kiokuko/dist/bin/kiokuko.js","mcp"]', '["/fixture/kiokuko/dist/bin/kiokuko.js","serve"]'),
    canonical.replace('/fixture/kiokuko/dist/bin/kiokuko.js', '/unrelated/script.js'),
    canonical.replace('["/fixture/kiokuko/dist/bin/kiokuko.js","mcp"]', '["/fixture/kiokuko/dist/bin/kiokuko.js","mcp","--custom"]'),
    canonical.replace('required = true', 'required = false'),
  ]) assert.throws(() => renderCodexMcpConfig(changed), error => error instanceof Error && 'code' in error && error.code === 'CONFLICT');
});
