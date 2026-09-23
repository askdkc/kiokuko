import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const forbiddenPackages = new Set([
  '@huggingface/hub',
  '@huggingface/transformers',
  'sqlite-vec',
  'onnxruntime-node',
  'sharp',
  'protobufjs',
  'boolean',
]);
let npmCacheDirectory;

async function run(command, args, cwd, environment = process.env) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...environment,
        npm_config_loglevel: 'warn',
        ...(npmCacheDirectory === undefined ? {} : { npm_config_cache: npmCacheDirectory }),
      },
    });
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr : '';
    const detail = [stdout, stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`, { cause: error });
  }
}

function packedFilename(stdout, packDirectory) {
  const records = JSON.parse(stdout);
  assert.ok(Array.isArray(records) && records.length === 1, 'npm pack must return one package record');
  assert.equal(typeof records[0].filename, 'string', 'npm pack must return a tarball filename');
  return path.join(packDirectory, records[0].filename);
}

async function installedPackageNames(nodeModulesDirectory, names = new Set()) {
  let entries;
  try {
    entries = await readdir(nodeModulesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return names;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === '.bin') continue;
    const entryPath = path.join(nodeModulesDirectory, entry.name);
    if (entry.name.startsWith('@')) {
      const scopedEntries = await readdir(entryPath, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        if (!scopedEntry.isDirectory()) continue;
        await recordInstalledPackage(path.join(entryPath, scopedEntry.name), names);
      }
      continue;
    }
    if (entry.isDirectory()) await recordInstalledPackage(entryPath, names);
  }
  return names;
}

async function recordInstalledPackage(packageDirectory, names) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  if (typeof manifest.name === 'string') names.add(manifest.name);
  await installedPackageNames(path.join(packageDirectory, 'node_modules'), names);
}

async function verifyInstalledSkillSetup(cliPath, installedRoot, fixtureRoot, packedFiles) {
  const homeDirectory = path.join(fixtureRoot, 'home');
  const environment = {
    PATH: process.env.PATH,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
    CODEX_HOME: path.join(fixtureRoot, 'codex-config'),
    CLAUDE_CONFIG_DIR: path.join(fixtureRoot, 'claude-config'),
    XDG_CONFIG_HOME: path.join(fixtureRoot, 'config'),
    KIOKUKO_DATA_DIR: path.join(fixtureRoot, 'data'),
    HERMES_HOME: path.join(fixtureRoot, 'hermes', 'profiles', 'smoke'),
    KIOKUKO_SKILL_DISCOVERY: 'off',
  };
  const skillDirectories = {
    codex: path.join(homeDirectory, '.agents', 'skills'),
    opencode: path.join(environment.XDG_CONFIG_HOME, 'opencode', 'skills'),
    claude: path.join(environment.CLAUDE_CONFIG_DIR, 'skills'),
    hermes: path.join(environment.HERMES_HOME, 'skills'),
  };
  await mkdir(homeDirectory, { recursive: true });
  await mkdir(environment.CODEX_HOME, { recursive: true });
  const hookPath = path.join(environment.CODEX_HOME, 'hooks.json');
  const userHook = { hooks: [{ type: 'command', command: 'user-owned-hook' }] };
  await writeFile(hookPath, JSON.stringify({ hooks: { Stop: [userHook] } }));
  const skillFiles = packedFiles.filter((file) => file.path.startsWith('skills/'));
  assert.ok(skillFiles.length > 0, 'the package must contain standard skills');
  const expected = new Map();
  for (const file of skillFiles) {
    const source = await readFile(path.join(repositoryRoot, file.path));
    assert.deepEqual(await readFile(path.join(installedRoot, file.path)), source, file.path);
    for (const [client, directory] of Object.entries(skillDirectories)) {
      expected.set(path.join(directory, file.path.slice('skills/'.length)), { client, content: source });
    }
  }
  const args = ['setup', '--clients', Object.keys(skillDirectories).join(','), '--command', cliPath, '--no-embeddings', '--json'];
  const setup = async (...extra) => {
    const { stdout } = await run(cliPath, [...args, ...extra], fixtureRoot, environment);
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true, stdout);
    for (const file of response.data.files) {
      const relative = path.relative(fixtureRoot, file.path);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), file.path);
    }
    return response.data.files.filter((file) => file.purpose === 'standard-skill');
  };
  const verifyFiles = async (files, actions) => {
    assert.deepEqual(files.map((file) => file.path).sort(), [...expected.keys()].sort());
    for (const file of files) {
      const target = expected.get(file.path);
      assert.equal(file.client, target.client, file.path);
      assert.equal(file.action, actions.get(file.path), file.path);
      assert.deepEqual(await readFile(file.path), target.content, file.path);
    }
  };

  const created = await setup();
  const installedHooks = JSON.parse(await readFile(hookPath, 'utf8')).hooks;
  assert.deepEqual(installedHooks.Stop[0], userHook);
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Interrupt', 'SubagentStart', 'SubagentStop']) {
    assert.ok(installedHooks[event].some(group => group.hooks.some(hook => hook.command.includes(' codex-hook --database '))), `Installed hook missing: ${event}`);
  }
  await verifyFiles(created, new Map([...expected.keys()].map((file) => [file, 'created'])));
  const beforeRepair = new Map();
  const repairActions = new Map();
  for (const [index, [file, target]] of [...expected].entries()) {
    if (Math.floor(index / Object.keys(skillDirectories).length) % 2 === 0) {
      await rm(file);
      beforeRepair.set(file, undefined);
      repairActions.set(file, 'created');
    } else {
      const stale = Buffer.concat([target.content, Buffer.from('\nold managed version\n')]);
      await writeFile(file, stale);
      beforeRepair.set(file, stale);
      repairActions.set(file, 'updated');
    }
  }
  const planned = await setup('--dry-run');
  assert.deepEqual(new Map(planned.map((file) => [file.path, file.action])), repairActions);
  assert.deepEqual(await setup('--no-standard-skills'), []);
  for (const [file, content] of beforeRepair) {
    if (content === undefined) {
      await assert.rejects(readFile(file), { code: 'ENOENT' });
    } else {
      assert.deepEqual(await readFile(file), content, file);
    }
  }

  await verifyFiles(await setup(), repairActions);
  const beforeRepeat = new Map();
  for (const file of expected.keys()) {
    const snapshot = await stat(file, { bigint: true });
    beforeRepeat.set(file, { ino: snapshot.ino, mtimeNs: snapshot.mtimeNs });
  }
  await verifyFiles(await setup(), new Map([...expected.keys()].map((file) => [file, 'unchanged'])));
  assert.deepEqual(JSON.parse(await readFile(hookPath, 'utf8')).hooks, installedHooks);
  for (const [file, before] of beforeRepeat) {
    const after = await stat(file, { bigint: true });
    assert.deepEqual({ ino: after.ino, mtimeNs: after.mtimeNs }, before, file);
  }
  process.stdout.write(`Installed setup verified ${skillFiles.length} skill files across ${Object.keys(skillDirectories).length} clients: create, repair, dry-run, skip, and unchanged rerun.\n`);
}

async function verifyInstalledProfileRebuild(cliPath, fixtureRoot) {
  await mkdir(fixtureRoot, { recursive: true });
  const databasePath = path.join(fixtureRoot, 'fixture.sqlite3');
  // This is the closed, checked-in sample fixture, never an operating database.
  await copyFile(path.join(repositoryRoot, 'tests/sampledb/kiokuko.sqlite3'), databasePath);
  const environment = { ...process.env, KIOKUKO_DATA_DIR: path.join(fixtureRoot, 'data'), KIOKUKO_SKILL_DISCOVERY: 'off' };
  const command = ['akinator-memory', 'rebuild'];
  await assert.rejects(run(cliPath, command, fixtureRoot, environment), /commander\.missingMandatoryOptionValue/u);
  await assert.rejects(run(cliPath, [...command, '--database', 'fixture.sqlite3'], fixtureRoot, environment), /--database must be an absolute path/u);
  for (const extra of [['--restart'], []]) {
    const { stdout } = await run(cliPath, [...command, '--database', databasePath, '--json', ...extra], fixtureRoot, environment);
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true, stdout);
    assert.equal(response.data.complete, true, stdout);
    assert.ok(response.data.projects > 0, stdout);
    if (extra.length === 0) assert.equal(response.data.processed, 0, 'a completed rebuild must resume without reprocessing');
  }
  process.stdout.write('Installed profile rebuild verified explicit database, restart, resume, and JSON output.\n');
}

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'kiokuko-global-install-'));
const packDirectory = path.join(temporaryRoot, 'pack');
const prefixDirectory = path.join(temporaryRoot, 'prefix');
npmCacheDirectory = path.join(temporaryRoot, 'npm-cache');

try {
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
  await mkdir(packDirectory, { recursive: true });
  await run('npm', ['run', 'build'], repositoryRoot);
  const packed = await run('npm', ['pack', '--pack-destination', packDirectory, '--json'], repositoryRoot);
  const packageFiles = new Set(JSON.parse(packed.stdout)[0].files.map((file) => file.path));
  for (const file of ['migrations/003_interaction_memory.sql', 'dist/memory/interaction-capture.js', 'dist/memory/interaction-recall.js', 'docs/interaction-memory.md']) {
    assert.ok(packageFiles.has(file), `interaction memory package artifact missing: ${file}`);
  }
  for (const file of ['migrations/004_memory_assurance.sql', 'dist/assurance/service.js', 'dist/commands/codex-hook.js', 'docs/memory-assurance.md']) {
    assert.ok(packageFiles.has(file), `Memory assurance package artifact missing: ${file}`);
  }
  for (const file of ['migrations/005_lesson_reinforcement.sql', 'dist/memory/lesson-reinforcement.js']) {
    assert.ok(packageFiles.has(file), `Lesson reinforcement package artifact missing: ${file}`);
  }
  const tarball = packedFilename(packed.stdout, packDirectory);
  const install = await run('npm', [
    'install',
    '--global',
    '--prefix',
    prefixDirectory,
    tarball,
  ], repositoryRoot);
  const npmOutput = `${install.stdout}\n${install.stderr}`;
  assert.doesNotMatch(npmOutput, /deprecated\s+boolean|install-scripts/iu, 'minimal install emitted an optional-runtime warning');

  const cliPath = path.join(prefixDirectory, 'bin', 'kiokuko');
  const version = await run(cliPath, ['--version'], repositoryRoot);
  assert.equal(version.stdout.trim(), packageJson.version, 'installed CLI version must match package.json');
  await verifyInstalledProfileRebuild(cliPath, path.join(temporaryRoot, 'profile-fixture'));

  await verifyInstalledSkillSetup(
    cliPath,
    path.join(prefixDirectory, 'lib', 'node_modules', packageJson.name),
    path.join(temporaryRoot, 'setup-fixture'),
    JSON.parse(packed.stdout)[0].files,
  );

  const installedNames = await installedPackageNames(path.join(prefixDirectory, 'lib', 'node_modules'));
  for (const forbidden of forbiddenPackages) {
    assert.equal(installedNames.has(forbidden), false, `${forbidden} must not be in the minimal dependency tree`);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write('Global install smoke test passed.\n');
