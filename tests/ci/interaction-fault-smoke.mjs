import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { toolData } from '../../scripts/lib/interaction-live-session.mjs';

assert.deepEqual(toolData({ result: { structured_content: { code: 'VALIDATION_ERROR' } } }), { code: 'VALIDATION_ERROR' });
assert.deepEqual(toolData({ result: { structuredContent: { enabled: true } } }), { enabled: true });
assert.deepEqual(toolData({ result: { content: [{ type: 'text', text: '{"items":[]}' }] } }), { items: [] });

const root = process.cwd();
const fixture = await mkdtemp(path.join(tmpdir(), 'kiokuko-fault-smoke-'));
const memory = { kind: 'preference', title: 'Japanese grammar', body: 'Use train examples for Japanese grammar.', scope: 'global',
  subjects: ['Japanese grammar'], portableReason: 'Grammar preferences apply across projects.', basis: 'user_statement' };
const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
try {
  for (const fault of ['conflict', 'response-loss']) {
    const log = path.join(fixture, `${fault}.jsonl`);
    const client = new Client({ name: 'fault-harness-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.join(root, 'scripts/lib/interaction-fault-proxy.mjs'), fault, log],
      env: { PATH: process.env.PATH, KIOKUKO_DATA_DIR: path.join(fixture, fault), KIOKUKO_EMBEDDINGS: 'off', KIOKUKO_SKILL_DISCOVERY: 'off' }, stderr: 'pipe' });
    try {
      await client.connect(transport);
      const first = { operationId: 'save', memories: [memory] };
      if (fault === 'response-loss') {
        await assert.rejects(client.callTool({ name: 'memory_capture', arguments: first }, undefined, { timeout: 1_000 }), /timed out/iu);
        const replay = await client.callTool({ name: 'memory_capture', arguments: first });
        assert.equal(replay.structuredContent.items[0].outcome, 'created');
        assert.equal(replay.structuredContent.items[0].availability, 'current');
      } else {
        const a = (await client.callTool({ name: 'memory_capture', arguments: first })).structuredContent.items[0];
        const correction = { ...memory, body: 'Use cooking examples for Japanese grammar.', basis: 'user_correction',
          replaces: { entryId: a.entryId, expectedRevision: a.revision } };
        const stale = await client.callTool({ name: 'memory_capture', arguments: { operationId: 'correct', memories: [correction] } });
        assert.equal(stale.isError, true);
        const found = (await client.callTool({ name: 'memory_recall', arguments: { soulRead: true, capabilities, query: 'Japanese grammar' } })).structuredContent.items[0];
        assert.equal(found.revision, a.revision + 1);
        const corrected = await client.callTool({ name: 'memory_capture', arguments: { operationId: 'fresh-correction',
          memories: [{ ...correction, replaces: { entryId: found.entryId, expectedRevision: found.revision } }] } });
        assert.equal(corrected.structuredContent.items[0].outcome, 'corrected');
      }
      const records = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(records.filter((record) => record.event === (fault === 'conflict' ? 'concurrent-write' : 'response-dropped')).length, 1);
      console.log(`${fault}: real server, one injected fault and recovery passed`);
    } finally { await client.close(); }
  }
} finally { await rm(fixture, { recursive: true, force: true }); }
