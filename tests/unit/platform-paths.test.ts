import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  getClaudeConfigDirectory,
  getClaudeInstructionsPath,
  getClaudeMcpConfigPath,
  getClaudeSkillsDirectory,
  getCodexConfigPath,
  getCodexInstructionsPath,
  getCodexSkillsDirectory,
  getDatabaseLockPath,
  getGlobalDatabasePath,
  getHermesConfigPath,
  getHermesHome,
  getOpenCodeConfigDirectory,
  getOpenCodeInstructionsPath,
  getOpenCodeLoopGuardPath,
  getOpenCodeSkillsDirectory,
  getHermesSkillsDirectory,
  getRuntimeDescriptorPath,
  getRuntimeDirectory,
} from '../../src/config/paths.js';

test('derives a per-database lock path from the resolved database path', () => {
  const databasePath = '/tmp/kiokuko-relative/../kiokuko.sqlite3';
  const fingerprint = createHash('sha256').update('/tmp/kiokuko.sqlite3').digest('hex');
  assert.equal(
    getDatabaseLockPath(databasePath, {
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/tmp/xdg-runtime' },
    }),
    `/tmp/xdg-runtime/kiokuko/${fingerprint}.lock`,
  );
});

test('derives the runtime descriptor path from the runtime directory', () => {
  assert.equal(
    getRuntimeDescriptorPath({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/tmp/xdg-runtime' },
    }),
    '/tmp/xdg-runtime/kiokuko/server.json',
  );
});

test('uses XDG runtime home on Linux', () => {
  assert.equal(
    getRuntimeDirectory({
      platform: 'linux',
      env: {
        XDG_RUNTIME_DIR: '/tmp/xdg-runtime',
        XDG_DATA_HOME: '/tmp/xdg-data',
        HOME: '/tmp/home',
      },
    }),
    '/tmp/xdg-runtime/kiokuko',
  );
});

test('falls back to the platform home data directory for runtime state', () => {
  assert.equal(
    getRuntimeDirectory({ platform: 'linux', env: { HOME: '/tmp/home' } }),
    '/tmp/home/.local/share/kiokuko',
  );
  assert.equal(
    getRuntimeDirectory({ platform: 'darwin', env: { HOME: '/tmp/home' } }),
    '/tmp/home/Library/Application Support/kiokuko',
  );
  assert.equal(
    getRuntimeDirectory({
      platform: 'win32',
      env: { LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local` },
    }),
    String.raw`C:\Users\test\AppData\Local\kiokuko`,
  );
});

test('uses XDG data home on Linux', () => {
  assert.equal(
    getGlobalDatabasePath({
      platform: 'linux',
      env: {
        XDG_DATA_HOME: '/tmp/xdg-data',
        HOME: '/tmp/home',
      },
    }),
    '/tmp/xdg-data/kiokuko/kiokuko.sqlite3',
  );
});

test('falls back to the platform home data directory', () => {
  assert.equal(
    getGlobalDatabasePath({
      platform: 'linux',
      env: { HOME: '/tmp/home' },
    }),
    '/tmp/home/.local/share/kiokuko/kiokuko.sqlite3',
  );
  assert.equal(
    getGlobalDatabasePath({
      platform: 'darwin',
      env: { HOME: '/tmp/home' },
    }),
    '/tmp/home/Library/Application Support/kiokuko/kiokuko.sqlite3',
  );
  assert.equal(
    getGlobalDatabasePath({
      platform: 'win32',
      env: { LOCALAPPDATA: String.raw`C:\Users\test\AppData\Local` },
    }),
    String.raw`C:\Users\test\AppData\Local\kiokuko\kiokuko.sqlite3`,
  );
});

test('derives documented global Codex, OpenCode, and Claude paths without touching the real home directory', () => {
  const options = {
    platform: 'linux' as const,
    env: { HOME: '/tmp/fake-home', XDG_CONFIG_HOME: '/tmp/fake-config' },
  };
  assert.equal(getCodexConfigPath(options), '/tmp/fake-home/.codex/config.toml');
  assert.equal(getCodexInstructionsPath(options), '/tmp/fake-home/.codex/AGENTS.md');
  assert.equal(getCodexSkillsDirectory(options), '/tmp/fake-home/.agents/skills');
  assert.equal(getOpenCodeConfigDirectory(options), '/tmp/fake-config/opencode');
  assert.equal(getOpenCodeInstructionsPath(options), '/tmp/fake-config/opencode/AGENTS.md');
  assert.equal(getOpenCodeLoopGuardPath(options), '/tmp/fake-config/opencode/plugins/kiokuko-loop-guard.js');
  assert.equal(getOpenCodeSkillsDirectory(options), '/tmp/fake-config/opencode/skills');
  assert.equal(getClaudeConfigDirectory(options), '/tmp/fake-home/.claude');
  assert.equal(getClaudeMcpConfigPath(options), '/tmp/fake-home/.claude.json');
  assert.equal(getClaudeInstructionsPath(options), '/tmp/fake-home/.claude/CLAUDE.md');
  assert.equal(getClaudeSkillsDirectory(options), '/tmp/fake-home/.claude/skills');
  assert.equal(getCodexConfigPath({ ...options, env: { ...options.env, CODEX_HOME: '/tmp/custom-codex' } }), '/tmp/custom-codex/config.toml');
  assert.equal(getClaudeMcpConfigPath({ ...options, env: { ...options.env, CLAUDE_CONFIG_DIR: '/tmp/custom-claude' } }), '/tmp/custom-claude/.claude.json');
  assert.equal(getClaudeInstructionsPath({ ...options, env: { ...options.env, CLAUDE_CONFIG_DIR: '/tmp/custom-claude' } }), '/tmp/custom-claude/CLAUDE.md');
  assert.equal(getClaudeSkillsDirectory({ ...options, env: { ...options.env, CLAUDE_CONFIG_DIR: '/tmp/custom-claude' } }), '/tmp/custom-claude/skills');
});

test('derives native standard-skill directories on macOS, Linux, and Windows', async () => {
  assert.equal(getCodexSkillsDirectory({ platform: 'darwin', env: { HOME: '/Users/test', CODEX_HOME: '/custom/codex' } }), '/Users/test/.agents/skills');
  assert.equal(getOpenCodeSkillsDirectory({ platform: 'darwin', env: { HOME: '/Users/test' } }), '/Users/test/.config/opencode/skills');
  assert.equal(getClaudeSkillsDirectory({ platform: 'darwin', env: { HOME: '/Users/test' } }), '/Users/test/.claude/skills');
  assert.equal(await getHermesSkillsDirectory({ platform: 'darwin', env: { HERMES_HOME: '/Users/test/.hermes/profiles/work' } }), '/Users/test/.hermes/profiles/work/skills');

  assert.equal(getOpenCodeSkillsDirectory({ platform: 'linux', env: { HOME: '/home/test', XDG_CONFIG_HOME: '/config' } }), '/config/opencode/skills');
  assert.equal(await getHermesSkillsDirectory({ platform: 'linux', env: { HERMES_HOME: '/home/test/.hermes/profiles/work' } }), '/home/test/.hermes/profiles/work/skills');

  const windowsEnvironment = {
    USERPROFILE: String.raw`C:\Users\test`,
    APPDATA: String.raw`C:\Users\test\AppData\Roaming`,
    CLAUDE_CONFIG_DIR: String.raw`D:\Claude`,
    HERMES_HOME: String.raw`D:\Hermes\profiles\work`,
  };
  assert.equal(getCodexSkillsDirectory({ platform: 'win32', env: windowsEnvironment }), String.raw`C:\Users\test\.agents\skills`);
  assert.equal(getOpenCodeSkillsDirectory({ platform: 'win32', env: windowsEnvironment }), String.raw`C:\Users\test\AppData\Roaming\opencode\skills`);
  assert.equal(getClaudeSkillsDirectory({ platform: 'win32', env: windowsEnvironment }), String.raw`D:\Claude\skills`);
  assert.equal(await getHermesSkillsDirectory({ platform: 'win32', env: windowsEnvironment }), String.raw`D:\Hermes\profiles\work\skills`);
});

test('resolves Linux and macOS Hermes default, named, custom, and profile-shaped homes', async () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const root = await mkdtemp(path.join(tmpdir(), `kiokuko-hermes-paths-${platform}-`));
    const home = path.join(root, 'home');
    const hermesRoot = path.join(home, '.hermes');
    await mkdir(hermesRoot, { recursive: true });

    const environment = { platform, env: { HOME: home } };
    assert.equal(await getHermesHome(environment), hermesRoot);

    await writeFile(path.join(hermesRoot, 'active_profile'), 'default\n');
    assert.equal(await getHermesHome(environment), hermesRoot);

    const namedProfile = path.join(hermesRoot, 'profiles', 'work');
    await mkdir(namedProfile, { recursive: true });
    await writeFile(path.join(hermesRoot, 'active_profile'), 'work\n');
    assert.equal(await getHermesHome(environment), namedProfile);
    assert.equal(await getHermesConfigPath(environment), path.join(namedProfile, 'config.yaml'));
    assert.equal(await getHermesSkillsDirectory(environment), path.join(namedProfile, 'skills'));

    const customRoot = path.join(root, 'custom-hermes');
    assert.equal(await getHermesHome({ platform, env: { HOME: home, HERMES_HOME: customRoot } }), customRoot);

    const customProfile = path.join(customRoot, 'profiles', 'work');
    await mkdir(customProfile, { recursive: true });
    await writeFile(path.join(customRoot, 'active_profile'), 'other\n');
    assert.equal(
      await getHermesHome({ platform, env: { HOME: home, HERMES_HOME: customProfile } }),
      customProfile,
    );
  }
});

test('rejects invalid or missing active Hermes profiles on Linux and macOS', async () => {
  for (const platform of ['linux', 'darwin'] as const) {
    for (const marker of ['', 'Main', 'profile/name', '..', 'a'.repeat(65), 'missing']) {
      const root = await mkdtemp(path.join(tmpdir(), `kiokuko-hermes-invalid-${platform}-`));
      const home = path.join(root, 'home');
      const hermesRoot = path.join(home, '.hermes');
      await mkdir(path.join(hermesRoot, 'profiles'), { recursive: true });
      await writeFile(path.join(hermesRoot, 'active_profile'), `${marker}\n`);

      await assert.rejects(
        getHermesHome({ platform, env: { HOME: home } }),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'VALIDATION_ERROR',
      );
    }
  }
});

test('uses hermes config path output when no active_profile marker exists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-hermes-config-path-'));
  const home = path.join(root, 'home');
  const profileHome = path.join(home, '.hermes', 'profiles', 'main');
  const bin = path.join(root, 'bin');
  const configPath = path.join(profileHome, 'config.yaml');
  await mkdir(profileHome, { recursive: true });
  await mkdir(bin, { recursive: true });
  const hermes = path.join(bin, 'hermes');
  await writeFile(hermes, '#!/bin/sh\nprintf "%s\\n" "$HERMES_CONFIG_PATH"\n');
  await chmod(hermes, 0o755);

  assert.equal(
    await getHermesHome({
      platform: 'linux',
      env: { HOME: home, PATH: bin, HERMES_CONFIG_PATH: configPath },
    }),
    profileHome,
  );
  assert.equal(
    await getHermesConfigPath({
      platform: 'darwin',
      env: { HOME: home, PATH: bin, HERMES_CONFIG_PATH: configPath },
    }),
    profileHome + '/config.yaml',
  );
});
