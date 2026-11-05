import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

test('installed recorder lookup validates status, worktree, bin identity and cancellation without PATH', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'kiokuko-service-contract-')));
  const installed = path.join(root, 'node_modules', 'agenticreplay');
  await mkdir(path.join(installed, 'lib'), { recursive: true });
  await mkdir(path.join(installed, 'bin'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(installed, 'package.json'), JSON.stringify({
    name: 'agenticreplay', type: 'module', exports: './lib/index.js', bin: { agenticreplay: 'bin/agenticreplay.js' },
  }));
  await writeFile(path.join(installed, 'lib', 'index.js'), 'export {};');
  await symlink(path.resolve(import.meta.dirname, '../../node_modules/zod'), path.join(root, 'node_modules', 'zod'), 'dir');
  const modulePath = path.join(root, 'codex-service.ts');
  await copyFile(path.resolve(import.meta.dirname, '../../src/agenticreplay/codex-service.ts'), modulePath);
  const service = await import(pathToFileURL(modulePath).href) as typeof import('../../src/agenticreplay/codex-service.js');
  const bin = path.join(installed, 'bin', 'agenticreplay.js');
  const configure = (value: unknown) => writeFile(bin, `console.log(${JSON.stringify(JSON.stringify(value))});`);
  const active = { status: 'running', socketPath: path.join(root, 'review.sock'), worktrees: [root] };
  const signal = new AbortController().signal;
  try {
    await configure(active);
    assert.equal(await service.discoverCodexDockSocket(root, signal), active.socketPath);
    assert.equal(await service.discoverCodexDockSocket(path.join(root, 'other'), signal), undefined);
    for (const status of ['stopped', 'configuration_changed', 'disabled', 'unsupported']) {
      await configure({ ...active, status });
      assert.equal(await service.discoverCodexDockSocket(root, signal), undefined);
    }
    await configure({ ...active, socketPath: 'relative.sock' });
    assert.equal(await service.discoverCodexDockSocket(root, signal), undefined);
    await writeFile(bin, 'console.log("not json");');
    assert.equal(await service.discoverCodexDockSocket(root, signal), undefined);
    await writeFile(bin, 'console.log("x".repeat(140000));');
    assert.equal(await service.discoverCodexDockSocket(root, signal), undefined);
    await writeFile(bin, 'setInterval(() => {}, 100);');
    const controller = new AbortController();
    const discovery = service.discoverCodexDockSocket(root, controller.signal);
    controller.abort();
    assert.equal(await discovery, undefined);
    const config = path.join(root, 'profile config.toml');
    await writeFile(bin, `
      const args = process.argv.slice(2);
      if (process.cwd() !== ${JSON.stringify(root)} || args.join('|') !== ${JSON.stringify(['codex-service', 'register', '--config', config, '--json'].join('|'))}) process.exit(1);
      console.log(${JSON.stringify(JSON.stringify(active))});
    `);
    await service.registerCodexDock(root, config, { ...process.env, PATH: '' });
    await configure({ error: { message: 'Codex endpoint conflict' } });
    await assert.rejects(service.registerCodexDock(root, config), /Codex endpoint conflict/);
    await rm(bin);
    assert.equal(await service.discoverCodexDockSocket(root, signal), undefined);
    await assert.rejects(service.registerCodexDock(root, config));
    await rm(installed, { recursive: true });
    assert.equal(await service.discoverCodexDockSocket(root, signal), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
