import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import semver from 'semver';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

// Consumers resolve the latest tag. Repository verification uses the version
// npm ci installed from the lockfile.
export function managedAgenticReplay(root = repositoryRoot) {
  const manifest = readJson(path.join(root, 'package.json'));
  if (manifest.dependencies?.agenticreplay !== 'latest') {
    throw new Error('Declare AgenticReplay as a latest runtime dependency');
  }
  const lock = readJson(path.join(root, 'package-lock.json'));
  const lockSpec = lock.packages?.['']?.dependencies?.agenticreplay;
  const lockedVersion = lock.packages?.['node_modules/agenticreplay']?.version;
  // npm tooling can serialize the unpinned root request as "*" while
  // package.json retains "latest". The resolved and installed versions below
  // still have to match exactly; this is not a recorder compatibility gate.
  if (!['latest', '*'].includes(lockSpec) || !semver.valid(lockedVersion)) {
    throw new Error('AgenticReplay lockfile does not resolve the latest dependency');
  }
  const installed = readJson(path.join(root, 'node_modules/agenticreplay/package.json'));
  if (installed.name !== 'agenticreplay' || installed.version !== lockedVersion) {
    throw new Error('Installed AgenticReplay does not match the lockfile; run npm ci');
  }
  const binary = path.join(root, 'node_modules/.bin', process.platform === 'win32' ? 'agenticreplay.cmd' : 'agenticreplay');
  if (!existsSync(binary)) throw new Error('The installed AgenticReplay executable is missing');
  return { version: installed.version, binary };
}
