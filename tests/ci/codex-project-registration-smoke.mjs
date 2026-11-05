import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile, access, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Installed Kiokuko and generated hooks, with only the recorder process substituted. */
export async function verifyInstalledCodexProjects(installedRoot, fixture, run) {
  await mkdir(fixture, { recursive: true });
  fixture = await realpath(fixture);
  const profile = path.join(fixture, 'profile');
  await mkdir(profile);
  const roots = ['first', 'second', 'added later'].map(name => path.join(fixture, name));
  for (const root of roots) await run('git', ['init', '-q', root], fixture);
  const environment = { PATH: process.env.PATH, HOME: fixture, USERPROFILE: fixture, CODEX_HOME: profile,
    KIOKUKO_DATA_DIR: path.join(fixture, 'data'), KIOKUKO_SKILL_DISCOVERY: 'off' };
  const config = path.join(profile, 'config.toml');
  const projectsFile = path.join(profile, '.codex-global-state.json');
  await writeFile(projectsFile, JSON.stringify({ 'electron-saved-workspace-roots': roots.slice(0, 2) }));
  const serviceState = path.join(fixture, 'recorder.json');
  const recorder = path.join(installedRoot, 'node_modules/agenticreplay/bin/agenticreplay.js');
  const original = await readFile(recorder);
  await writeFile(recorder, `
    import{readFileSync,writeFileSync,existsSync}from'node:fs';
    const file=${JSON.stringify(serviceState)};
    const value=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{status:'disabled',worktrees:[]};
    const args=process.argv.slice(2);
    if(args[1]==='register'){
      if(args[3]!==${JSON.stringify(config)}||!existsSync(process.cwd()+'/.kiokuko.json'))process.exit(1);
      value.status='running';value.socketPath=${JSON.stringify(path.join(fixture, 'review.sock'))};
      value.worktrees=[...new Set([...value.worktrees,process.cwd()])];writeFileSync(file,JSON.stringify(value));
    }
    console.log(JSON.stringify(value));
  `);
  try {
    // The installed setup entry uses a macOS host contract, including on Linux CI.
    const setupEntry = pathToFileURL(path.join(installedRoot, 'dist/commands/setup.js')).href;
    const options = { clients: ['codex'], platform: 'darwin', cwd: fixture, env: environment,
      standardSkills: false, codexDockRecord: true };
    const setup = await run(process.execPath, ['--input-type=module', '-e',
      `import{setupGlobalClients}from ${JSON.stringify(setupEntry)};console.log(JSON.stringify(await setupGlobalClients(${JSON.stringify(options)})));`], fixture, environment);
    assert.equal(JSON.parse(setup.stdout).codexDockRecording.status, 'running');
    assert.deepEqual(JSON.parse(await readFile(serviceState, 'utf8')).worktrees, roots.slice(0, 2));
    for (const root of roots.slice(0, 2)) { await access(path.join(root, '.kiokuko.json')); await access(path.join(root, 'AGENTS.md')); }
    await writeFile(projectsFile, JSON.stringify({ 'electron-saved-workspace-roots': roots }));
    const hooks = JSON.parse(await readFile(path.join(profile, 'hooks.json'), 'utf8'));
    const command = hooks.hooks.SessionStart[0].hooks[0].command;
    assert.match(command, /--codex-dock-record --codex-config/u);
    const event = { hook_event_name: 'SessionStart', session_id: 'added-project', cwd: roots[2] };
    const invoke = () => new Promise((resolve, reject) => {
      const child = execFile('/bin/sh', ['-c', command], { cwd: fixture, env: environment, timeout: 30_000, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(error); else resolve({ stdout, stderr });
      });
      child.stdin.end(JSON.stringify(event));
    });
    const first = await invoke();
    assert.equal(first.stderr, '');
    assert.ok(JSON.parse(first.stdout).hookSpecificOutput.additionalContext);
    assert.deepEqual(JSON.parse(await readFile(serviceState, 'utf8')).worktrees, roots);
    const binding = await readFile(path.join(roots[2], '.kiokuko.json'), 'utf8');
    const agent = await readFile(path.join(roots[2], 'AGENTS.md'), 'utf8');
    await invoke();
    assert.equal(await readFile(path.join(roots[2], '.kiokuko.json'), 'utf8'), binding);
    assert.equal(await readFile(path.join(roots[2], 'AGENTS.md'), 'utf8'), agent);
    await unlink(path.join(roots[2], 'AGENTS.md'));
    await invoke();
    await assert.rejects(access(path.join(roots[2], 'AGENTS.md')), { code: 'ENOENT' });
    await writeFile(serviceState, JSON.stringify({ status: 'disabled', worktrees: [] }));
    await invoke();
    assert.equal(JSON.parse(await readFile(serviceState, 'utf8')).status, 'disabled');
    // A recorder failure must still return the normal SessionStart reminder.
    await writeFile(recorder, 'process.exit(1);');
    const failed = await invoke();
    assert.match(failed.stderr, /registration failed/u);
    assert.ok(JSON.parse(failed.stdout).hookSpecificOutput.additionalContext);
    process.stdout.write('Installed Codex projects verified: setup outside checkout, generated hook registration, stable bindings, removed instructions, explicit disable and nonblocking recorder failure.\n');
  } finally { await writeFile(recorder, original); }
}
