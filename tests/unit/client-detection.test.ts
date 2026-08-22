import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isHermesAgentInstalled } from '../../src/setup/client-detection.js';

test('detects Hermes from profile state and executable path without writing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-hermes-detection-'));
  const home = path.join(root, 'home');
  const hermesHome = path.join(home, '.hermes');
  await mkdir(hermesHome, { recursive: true });

  assert.equal(await isHermesAgentInstalled({ platform: 'linux', env: { HOME: home, PATH: '' } }), false);

  await writeFile(path.join(hermesHome, 'config.yaml'), 'mcp_servers: {}\n');
  assert.equal(await isHermesAgentInstalled({ platform: 'linux', env: { HOME: home, PATH: '' } }), true);

  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const executable = path.join(bin, 'hermes');
  await writeFile(executable, '#!/bin/sh\n');
  await chmod(executable, 0o755);
  assert.equal(await isHermesAgentInstalled({ platform: 'linux', env: { HOME: path.join(root, 'other-home'), PATH: bin } }), true);
});
