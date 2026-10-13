import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { verifyInstalledTaskHookRecovery } from '../ci/task-hook-recovery-smoke.mjs';

test('runtime-prepare publishes a verified, independently launchable runtime', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-runtime-'));
  try {
    const node = process.env.KIOKUKO_TEST_STANDALONE_NODE ?? process.execPath;
    const prepare = spawnSync(process.execPath, ['dist/bin/kiokuko.js', 'runtime-prepare', '--runtime-root', root, '--node', node, '--json'], {
      cwd: path.resolve('.'), encoding: 'utf8', timeout: 300_000,
    });
    assert.equal(prepare.status, 0, prepare.stdout + prepare.stderr + String(prepare.error ?? ''));
    const result = JSON.parse(prepare.stdout);
    assert.equal(typeof result.runtimeId, 'string');
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    assert.equal(manifest.runtimeId, result.runtimeId);
    assert.equal(manifest.packageVersion, '1.0.35');
    assert.ok((await stat(result.nodePath)).isFile());
    const version = spawnSync(result.nodePath, [result.cliPath, 'version'], { encoding: 'utf8', env: { PATH: '' } });
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), manifest.packageVersion);
    const forbidden = spawnSync(result.nodePath, [result.cliPath, 'setup', '--dry-run'], { encoding: 'utf8', env: { PATH: '' } });
    assert.notEqual(forbidden.status, 0);
    assert.match(forbidden.stderr, /read-only/u);
    const sqliteModule = pathToFileURL(path.join(result.root, 'app', 'dist', 'embedding', 'sqlite-vec-loader.js')).href;
    const sqliteProbe = `import { DatabaseSync } from 'node:sqlite'; import { createSqliteVecLoader } from ${JSON.stringify(sqliteModule)}; const loader = await createSqliteVecLoader(); if (!loader) process.exit(9); const db = new DatabaseSync(':memory:', { allowExtension: true }); loader.load(db); if (typeof db.prepare('select vec_version() as version').get().version !== 'string') process.exit(10); db.close();`;
    const native = spawnSync(result.nodePath, ['--input-type=module', '--eval', sqliteProbe], { encoding: 'utf8', env: { PATH: '' } });
    assert.equal(native.status, 0, native.stderr);
    const env = { HOME: root, CODEX_HOME: path.join(root, 'codex'), KIOKUKO_DATA_DIR: path.join(root, 'data'), PATH: '' };
    const init = spawnSync(process.execPath, ['dist/bin/kiokuko.js', 'init', '--json'], { cwd: path.resolve('.'), env, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stdout + init.stderr);
    const switchArgs = ['dist/bin/kiokuko.js', 'setup', '--clients', 'codex', '--no-embeddings', '--no-standard-skills', '--runtime-manifest', result.manifestPath];
    const notStopped = spawnSync(process.execPath, [...switchArgs, '--json'], { cwd: path.resolve('.'), env, encoding: 'utf8' });
    assert.notEqual(notStopped.status, 0);
    const setup = spawnSync(process.execPath, ['dist/bin/kiokuko.js', 'setup', '--clients', 'codex', '--no-embeddings', '--no-standard-skills', '--runtime-manifest', result.manifestPath, '--client-stopped', '--json'], {
      cwd: path.resolve('.'), env, encoding: 'utf8', timeout: 300_000,
    });
    assert.equal(setup.status, 0, setup.stdout + setup.stderr);
    const config = await readFile(path.join(root, 'codex', 'config.toml'), 'utf8');
    const hooks = JSON.parse(await readFile(path.join(root, 'codex', 'hooks.json'), 'utf8'));
    assert.ok(config.includes(JSON.stringify(result.nodePath)));
    assert.ok(config.includes(JSON.stringify([result.cliPath, 'mcp'])));
    for (const groups of Object.values(hooks.hooks) as Array<Array<{ hooks: Array<{ command: string }> }>>) {
      assert.ok(groups.some(group => group.hooks.some(hook => hook.command.includes(result.nodePath) && hook.command.includes(result.cliPath))));
    }
    const diagnoseArgs = ['dist/bin/kiokuko.js', 'runtime-diagnose', '--manifest', result.manifestPath, '--json'];
    const diagnosed = spawnSync(process.execPath, diagnoseArgs, { cwd: path.resolve('.'), env, encoding: 'utf8' });
    assert.equal(diagnosed.status, 0, diagnosed.stdout + diagnosed.stderr);
    assert.equal(JSON.parse(diagnosed.stdout).readyForRestart, true);
    const hookPath = path.join(root, 'codex', 'hooks.json');
    const hookText = await readFile(hookPath, 'utf8');
    await writeFile(hookPath, hookText.replace(result.cliPath, '/wrong/dist/bin/kiokuko.js'));
    const mismatch = spawnSync(process.execPath, diagnoseArgs, { cwd: path.resolve('.'), env, encoding: 'utf8' });
    assert.notEqual(mismatch.status, 0);
    assert.equal(JSON.parse(mismatch.stdout).hooksMatch, false);
    await writeFile(hookPath, hookText);
    const client = new Client({ name: 'saved-runtime-test', version: '1.0.0' });
    try {
      await client.connect(new StdioClientTransport({ command: result.nodePath, args: [result.cliPath, 'mcp'], cwd: root, env, stderr: 'pipe' }));
      assert.ok((await client.listTools()).tools.some(tool => tool.name === 'task_prepare'));
    } finally { await client.close(); }
    await verifyInstalledTaskHookRecovery(path.join(result.root, 'app'), path.join(root, 'pinned-hook-recovery'), {
      managementCli: path.resolve('dist/bin/kiokuko.js'), runtimeNode: result.nodePath,
    });
    const before = config + JSON.stringify(hooks);
    const failed = spawnSync(process.execPath, [...switchArgs, '--client-stopped', '--command', '/another/kiokuko', '--json'], { cwd: path.resolve('.'), env, encoding: 'utf8' });
    assert.notEqual(failed.status, 0);
    assert.equal((await readFile(path.join(root, 'codex', 'config.toml'), 'utf8')) + JSON.stringify(JSON.parse(await readFile(path.join(root, 'codex', 'hooks.json'), 'utf8'))), before);
    const again = spawnSync(process.execPath, ['dist/bin/kiokuko.js', 'runtime-prepare', '--runtime-root', root, '--node', node, '--json'], {
      cwd: path.resolve('.'), encoding: 'utf8', timeout: 300_000,
    });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).runtimeId, result.runtimeId);
    await chmod(result.cliPath, 0o600);
    await writeFile(result.cliPath, 'damaged runtime\n');
    const damaged = spawnSync(process.execPath, ['dist/bin/kiokuko.js', 'runtime-prepare', '--runtime-root', root, '--node', node, '--json'], {
      cwd: path.resolve('.'), encoding: 'utf8', timeout: 300_000,
    });
    assert.notEqual(damaged.status, 0);
    assert.equal(await readFile(result.cliPath, 'utf8'), 'damaged runtime\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
