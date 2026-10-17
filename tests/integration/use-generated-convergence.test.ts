import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, lstat, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { useRepository } from '../../src/commands/use.js';
import { atomicWriteTextIfUnchanged } from '../../src/agent-file/atomic-write.js';
import { renderGeneratedAgentFile } from '../../src/agent-file/render.js';
import { openConnection } from '../../src/db/connection.js';

for (const peer of ['identical', 'different', 'symlink'] as const) {
  test(`generated-body convergence handles a ${peer} peer after binding publication`, async t => {
    const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'kiokuko-generated-convergence-')));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const root = path.join(directory, 'project'); await mkdir(root);
    const databasePath = path.join(directory, 'memory.sqlite3');
    const bindingPath = path.join(root, '.kiokuko.json');
    const generatedPath = path.join(root, '.kiokuko/AGENTS.md');
    const outside = path.join(directory, 'outside.md');
    await writeFile(path.join(root, 'AGENTS.md'), 'human header\n');
    await writeFile(outside, 'outside original\n');
    let peerContent = '', injected = false;
    const operation = useRepository({ root, allowDirectory: true, databasePath }, {
      atomicWriteTextIfUnchanged: async (filePath, content, expectation, mode) => {
        const result = await atomicWriteTextIfUnchanged(filePath, content, expectation, mode);
        if (filePath === bindingPath && !injected) {
          injected = true;
          const config = JSON.parse(content);
          const cliCommand = process.env.npm_command === 'exec' || process.env.npm_lifecycle_event === 'npx'
            ? 'npm exec -- kiokuko' as const : 'kiokuko' as const;
          peerContent = renderGeneratedAgentFile(undefined, {
            repositoryId: config.repositoryId, workspace: config.workspace, cliCommand,
          }).content;
          await mkdir(path.dirname(generatedPath));
          if (peer === 'symlink') {
            const { symlink } = await import('node:fs/promises');
            await symlink(outside, generatedPath);
          } else {
            if (peer === 'different') peerContent = 'peer user-owned content\n';
            await writeFile(generatedPath, peerContent, { flag: 'wx', mode: 0o644 });
          }
        }
        return result;
      },
    });
    if (peer === 'identical') {
      const result = await operation;
      assert.equal(JSON.parse(await readFile(bindingPath, 'utf8')).repositoryId, result.repositoryId);
      assert.equal(await readFile(generatedPath, 'utf8'), peerContent);
      const agent = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
      assert.match(agent, /^human header\n/u);
      assert.equal((agent.match(/BEGIN KIOKUKO MANAGED BLOCK/gu) ?? []).length, 1);
    } else {
      await assert.rejects(operation, (error: unknown) => error instanceof Error && 'code' in error
        && (error.code === 'CONFLICT' || error.code === 'SECURITY_REJECTION'));
      assert.equal(await readFile(path.join(root, 'AGENTS.md'), 'utf8'), 'human header\n');
      if (peer === 'different') assert.equal(await readFile(generatedPath, 'utf8'), peerContent);
      else assert.equal((await lstat(generatedPath)).isSymbolicLink(), true);
    }
    assert.equal(injected, true);
    assert.equal(await readFile(outside, 'utf8'), 'outside original\n');
    const database = openConnection(databasePath, { readOnly: true });
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count, peer === 'identical' ? 1 : 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count, peer === 'identical' ? 1 : 0);
    } finally { database.close(); }
  });
}
