import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('recovery adapter records discovery, injects one real selector rejection, then forwards legal reads without repair', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'kiokuko-selector-proxy-'));
  const log = path.join(base, 'protocol.jsonl');
  const client = new Client({ name: 'recovery-adapter-selftest', version: '1' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: ['--import', import.meta.resolve('tsx'), path.resolve('scripts/lib/normal-workflow/mcp-proxy.mjs'),
        path.resolve('src/bin/kiokuko.ts'), log, 'selector-once'], cwd: base,
      env: { PATH: process.env.PATH ?? '', KIOKUKO_DATA_DIR: path.join(base, 'data'), KIOKUKO_SKILL_DISCOVERY: 'off', KIOKUKO_EMBEDDINGS: 'off' }, stderr: 'pipe' }));
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'task_inspect'));
    const first = await client.callTool({ name: 'task_inspect', arguments: { cwd: base, operation: 'skill' } });
    assert.equal(first.isError, true);
    assert.equal((first.structuredContent as any).reason, 'skill');
    const selector = 'skills/kiokuko-codex-soul/SKILL.md';
    const recovered = await client.callTool({ name: 'task_inspect', arguments: { cwd: base, operation: 'skill', path: selector } });
    assert.notEqual(recovered.isError, true);
    assert.match((recovered.structuredContent as any).text, /# Kiokuko SOUL router/u);
    const repeated = await client.callTool({ name: 'task_inspect', arguments: { cwd: base, operation: 'skill', path: selector } });
    assert.deepEqual(repeated.structuredContent, recovered.structuredContent);
    const records = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(records.filter(record => record.type === 'injected_selector').length, 1);
    assert.ok(records.some(record => Array.isArray(record.message?.result?.tools)));
    assert.ok(records.some(record => record.direction === 'request' && record.message?.params?.arguments?.path === selector));
  } finally { await client.close(); rmSync(base, { recursive: true, force: true }); }
});
