import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { optionalRuntimeInstallInvocation } from '../../src/commands/embeddings.js';

const execFileAsync = promisify(execFile);

test('macOS runtime install accepts the shipped script policy and runs approved scripts with real npm', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kiokuko-runtime-install-'));
  const registry = createServer();
  try {
    const packageRoot = path.join(directory, 'kiokuko');
    const fixtureRoot = path.join(directory, 'runtime');
    await Promise.all([mkdir(packageRoot), mkdir(fixtureRoot)]);
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      private: true,
      allowScripts: manifest.allowScripts,
    }));
    // Serve a fixture as a registry dependency: npm approves registry identities by name,
    // whereas installing a file tarball requires a different, path-based policy.
    await writeFile(path.join(fixtureRoot, 'package.json'), JSON.stringify({
      name: 'onnxruntime-node',
      version: '0.0.0',
      scripts: { postinstall: 'node install.cjs' },
    }));
    await writeFile(path.join(fixtureRoot, 'install.cjs'), "require('node:fs').writeFileSync('installed.txt', 'ready');\n");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      npm_config_cache: path.join(directory, 'cache'),
      npm_config_offline: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_ignore_scripts: 'false',
      npm_config_strict_allow_scripts: 'true',
      npm_config_dangerously_allow_all_scripts: 'false',
    };
    // An inherited CLI allow-scripts setting is forbidden for project installs.
    // Test the shipped package.json policy, retaining strict checks above.
    for (const key of Object.keys(env)) {
      if (key.toLowerCase().replaceAll('-', '_') === 'npm_config_allow_scripts') delete env[key];
    }
    const packed = await execFileAsync('npm', ['pack', '--json', '--ignore-scripts'], { cwd: fixtureRoot, env });
    const tarball = path.join(fixtureRoot, JSON.parse(packed.stdout)[0].filename);
    const tarballContent = await readFile(tarball);
    registry.listen(0, '127.0.0.1');
    await once(registry, 'listening');
    const address = registry.address();
    assert.ok(address && typeof address === 'object');
    const registryUrl = `http://127.0.0.1:${address.port}`;
    registry.on('request', (request, response) => {
      if (request.url === '/onnxruntime-node/-/onnxruntime-node-0.0.0.tgz') {
        response.end(tarballContent);
      } else if (request.url === '/onnxruntime-node') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
          name: 'onnxruntime-node',
          versions: {
            '0.0.0': {
              name: 'onnxruntime-node',
              version: '0.0.0',
              scripts: { postinstall: 'node install.cjs' },
              dist: { tarball: `${registryUrl}/onnxruntime-node/-/onnxruntime-node-0.0.0.tgz` },
            },
          },
        }));
      } else {
        response.writeHead(404).end();
      }
    });
    const invocation = optionalRuntimeInstallInvocation('darwin', packageRoot);
    // Substitute only the dependency artifacts; retain the production install options.
    const args = invocation.args.filter((arg) => !arg.startsWith('@huggingface/') && !arg.startsWith('sqlite-vec@'));
    await execFileAsync(invocation.command, [...args, 'onnxruntime-node@0.0.0'], {
      cwd: invocation.cwd,
      timeout: 10_000,
      env: { ...env, npm_config_offline: 'false', npm_config_registry: registryUrl, npm_config_fetch_retries: '0' },
    });
    assert.equal(await readFile(path.join(packageRoot, 'node_modules/onnxruntime-node/installed.txt'), 'utf8'), 'ready');
    assert.deepEqual(JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')), {
      name: manifest.name,
      version: manifest.version,
      private: true,
      allowScripts: manifest.allowScripts,
    });
    await assert.rejects(readFile(path.join(packageRoot, 'package-lock.json')), { code: 'ENOENT' });
  } finally {
    await new Promise<void>((resolve) => registry.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
