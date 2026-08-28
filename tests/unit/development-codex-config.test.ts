import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const configPath = path.join(repositoryRoot, '.codex', 'config.toml');
const launcherPath = path.join(repositoryRoot, '.codex', 'kiokuko-dev-mcp.mjs');

test('tracked Codex development config has no developer-specific clone path', async () => {
  const config = await readFile(configPath, 'utf8');
  assert.match(config, /^command = "node"$/mu);
  assert.match(config, /^args = \["\.codex\/kiokuko-dev-mcp\.mjs"\]$/mu);
  assert.match(config, /^cwd = "\."$/mu);
  assert.doesNotMatch(config, /(?:\/Users\/|~[/\\]|[A-Za-z]:\\)/u);
  assert.doesNotMatch(config, /KIOKUKO_DATA_DIR/u);
});

test('Codex development launcher resolves the sample database from its clone', async () => {
  const launcher = await import(pathToFileURL(launcherPath).href) as {
    resolveSampleDatabasePath(moduleUrl?: string | URL): string;
  };
  const cloneRoot = path.join(path.parse(repositoryRoot).root, 'portable-clone', 'kiokuko');
  const cloneLauncher = pathToFileURL(path.join(cloneRoot, '.codex', 'kiokuko-dev-mcp.mjs'));
  assert.equal(
    launcher.resolveSampleDatabasePath(cloneLauncher),
    path.join(cloneRoot, 'tests', 'sampledb', 'kiokuko.sqlite3'),
  );
});

test('Codex development launcher tests against a disposable copy of the sample database', async () => {
  const launcher = await import(pathToFileURL(launcherPath).href) as {
    createDevelopmentDatabaseCopy(moduleUrl?: string | URL): Promise<{
      dataDirectory: string;
      databasePath: string;
      remove(): Promise<void>;
    }>;
    resolveSampleDatabasePath(moduleUrl?: string | URL): string;
  };
  const sourcePath = launcher.resolveSampleDatabasePath();
  const sourceBefore = await readFile(sourcePath);
  const databaseCopy = await launcher.createDevelopmentDatabaseCopy();
  try {
    assert.notEqual(databaseCopy.databasePath, sourcePath);
    assert.deepEqual(await readFile(databaseCopy.databasePath), sourceBefore);
    await writeFile(databaseCopy.databasePath, 'modified disposable copy');
    assert.deepEqual(await readFile(sourcePath), sourceBefore);
  } finally {
    await databaseCopy.remove();
  }
  await assert.rejects(access(databaseCopy.dataDirectory));
});
