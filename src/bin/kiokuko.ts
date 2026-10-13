#!/usr/bin/env node
import { supportsNodeVersion, unsupportedNodeMessage } from '../runtime-version.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pinnedManifest = fileURLToPath(new URL('../../../manifest.json', import.meta.url));
if (existsSync(pinnedManifest) && !['mcp', 'codex-hook', 'version'].includes(process.argv[2] ?? '')) {
  process.stderr.write('This saved Kiokuko runtime is read-only. Run management commands from the normal installation.\n');
  process.exit(1);
}

if (!supportsNodeVersion(process.versions.node)) {
  process.stderr.write(`${unsupportedNodeMessage(process.versions.node)}\n`);
  process.exitCode = 1;
} else {
  const { runCli } = await import('../cli.js');
  const exitCode = await runCli();
  if (exitCode !== 0) process.exitCode = exitCode;
}
