import assert from 'node:assert/strict';
import test from 'node:test';
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { initializeDatabase } from '../../src/commands/init.js';
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
  await mkdir(path.join(root, 'agenticreplay'));
  for (const directory of ['setup', 'repository']) await symlink(path.resolve(import.meta.dirname, '../../src', directory), path.join(root, directory), 'dir');
  const modulePath = path.join(root, 'agenticreplay', 'codex-service.ts');
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
    const project = path.join(root, 'new project');
    execFileSync('git', ['init', '-q', project]);
    const database = path.join(root, 'memory.sqlite3');
    await initializeDatabase({ databasePath: database });
    const state = path.join(root, '.codex-global-state.json');
    await writeFile(state, JSON.stringify({ 'local-projects': { p: { rootPaths: [project] } } }));
    await writeFile(bin, `
      import { existsSync } from 'node:fs';
      const args = process.argv.slice(2);
      if (args[1] === 'register') {
        if (process.cwd() !== ${JSON.stringify(project)} || args[3] !== ${JSON.stringify(config)}
          || !existsSync(${JSON.stringify(path.join(project, '.kiokuko.json'))})) process.exit(1);
        console.log(${JSON.stringify(JSON.stringify({ ...active, worktrees: [root, project] }))});
      } else console.log(${JSON.stringify(JSON.stringify({ ...active, status: 'stopped', worktrees: [root, project] }))});
    `);
    await service.syncCodexDockProject(project, config, database);
    await access(path.join(project, '.kiokuko.json'));
    await access(path.join(project, 'AGENTS.md'));
    const binding = await readFile(path.join(project, '.kiokuko.json'), 'utf8');
    const agent = await readFile(path.join(project, 'AGENTS.md'), 'utf8');
    await configure({ ...active, worktrees: [root, project] });
    await service.syncCodexDockProject(project, config, database);
    assert.equal(await readFile(path.join(project, '.kiokuko.json'), 'utf8'), binding);
    assert.equal(await readFile(path.join(project, 'AGENTS.md'), 'utf8'), agent);
    await rm(path.join(project, 'AGENTS.md'));
    await service.syncCodexDockProject(project, config, database);
    await assert.rejects(access(path.join(project, 'AGENTS.md')), { code: 'ENOENT' });
    await rm(path.join(project, '.kiokuko.json'));
    await service.syncCodexDockProject(project, config, database);
    await assert.rejects(access(path.join(project, 'AGENTS.md')), { code: 'ENOENT' });
    await configure({ status: 'disabled' });
    await service.syncCodexDockProject(project, config, database);
    await assert.rejects(access(path.join(project, '.kiokuko.json')), { code: 'ENOENT' });
    await writeFile(state, JSON.stringify({ 'electron-saved-workspace-roots': [] }));
    await configure(active);
    await service.syncCodexDockProject(project, config, database);
    await assert.rejects(access(path.join(project, '.kiokuko.json')), { code: 'ENOENT' });
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
