import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { inspectTask } from '../../src/assurance/inspect.js';
import { repositoryStateDigest } from '../../src/assurance/snapshot.js';
import { handleCodexHook } from '../../src/assurance/codex-hooks.js';
import { prepareAgentTask } from '../../src/akinator/agent-task.js';
import { initializeDatabase } from '../../src/commands/init.js';
import { openConnection } from '../../src/db/connection.js';
import { createKiokukoMcpServer } from '../../src/mcp/server.js';
import { STANDARD_SKILL_MANIFESTS, deployedSkillName } from '../../src/setup/standard-skills.js';

const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];

test('public MCP Skill selectors preserve manifest identity across aliases, prefixes and separators', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'kiokuko-selector-matrix-'));
  const server = createKiokukoMcpServer({ cwd: () => cwd });
  const client = new Client({ name: 'selector-contract', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  const read = async (selector?: string) => {
    const result = await client.callTool({ name: 'task_inspect', arguments: { cwd, operation: 'skill', ...(selector === undefined ? {} : { path: selector }) } });
    assert.notEqual(result.isError, true, `${selector}: ${JSON.stringify(result)}`);
    return result.structuredContent as { text: string; contentHash: string };
  };
  try {
    assert.deepEqual(await read(), await read('kiokuko-soul'));
    assert.match((await read('coding-ideal-routine-skill')).text, /^---\nname: coding-ideal-routine-skill\n/u);
    for (const manifest of STANDARD_SKILL_MANIFESTS) {
      for (const file of manifest.files) {
        const expected = await read(`${manifest.name}/${file}`);
        assert.ok(expected.text.includes(manifest.managedMarker));
        for (const name of [manifest.name, deployedSkillName(manifest.name, 'codex')]) {
          const selectors = [`${name}/${file}`, `skills/${name}/${file}`];
          if (file === 'SKILL.md') selectors.push(name, `skills/${name}`);
          for (const selector of selectors) {
            assert.deepEqual(await read(selector), expected, selector);
            assert.deepEqual(await read(selector.replaceAll('/', '\\')), expected, selector);
          }
        }
        assert.deepEqual(await read(path.resolve('skills', manifest.name, file)), expected);
      }
    }
    const sentinel = 'external sentinel must never be returned';
    writeFileSync(path.join(cwd, 'secret.md'), sentinel);
    const rejected = ['', '.', 'Skills/kiokuko-soul/SKILL.md', 'skills//kiokuko-soul/SKILL.md',
      'kiokuko-soul/./SKILL.md', 'kiokuko-soul/SKILL.md/', 'KIOKUKO-SOUL', 'kiokuko-soul/%2e%2e/secret.md',
      '../secret.md', '..\\secret.md', 'skills/../kiokuko-soul/SKILL.md', 'skills\\..\\kiokuko-soul\\SKILL.md',
      'skills/kiokuko-codex-soul\\..\\secret.md', '/outside/kiokuko-soul/SKILL.md',
      'C:\\skills\\kiokuko-soul\\SKILL.md', '\\\\server\\skills\\kiokuko-soul\\SKILL.md',
      path.join(cwd, 'secret.md'), 'unknown-skill', 'kiokuko-soul/references/not-in-manifest.md',
      'kiokuko-soul/package.json'];
    for (const selector of rejected) {
      const result = await client.callTool({ name: 'task_inspect', arguments: { cwd, operation: 'skill', path: selector } });
      assert.equal(result.isError, true, selector);
      assert.equal((result.structuredContent as any).code, 'VALIDATION_ERROR', selector);
      assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
      // A rejected selector does not disable legal recovery.
      assert.deepEqual(await read('kiokuko-codex-soul'), await read());
    }
  } finally { await client.close(); await server.close(); rmSync(cwd, { recursive: true, force: true }); }
});
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'protocol.file.allow=always', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
  }).trim();
}
function commit(root: string): void {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
}
function submoduleFixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'kiokuko-submodule-preparation-'));
  const leaf = path.join(base, 'leaf');
  const module = path.join(base, 'module');
  const source = path.join(base, 'source');
  const root = path.join(base, 'clone');
  for (const directory of [leaf, module, source]) {
    mkdirSync(directory);
    git(directory, 'init', '-q');
    writeFileSync(path.join(directory, 'source.txt'), 'fixture\n');
    commit(directory);
  }
  git(module, 'submodule', 'add', '-q', leaf, 'nested');
  commit(module);
  git(source, 'submodule', 'add', '-q', module, 'module');
  commit(source);
  git(base, 'clone', '-q', source, root);
  git(root, 'remote', 'remove', 'origin'); // Local fixture URLs are outside the project identity contract.
  return { base, root };
}

test('preparation and observed hooks work in a fresh clone without initializing recursive submodules', async () => {
  const f = submoduleFixture();
  const databasePath = path.join(f.base, 'memory.sqlite3');
  await initializeDatabase({ databasePath });
  const db = openConnection(databasePath);
  try {
    assert.deepEqual(readdirSync(path.join(f.root, 'module')), []);
    assert.match(git(f.root, 'submodule', 'status'), /^-/u);
    const digest = repositoryStateDigest(f.root);
    assert.match(inspectTask({ cwd: f.root, operation: 'skill' }).text, /# Kiokuko SOUL router/u);
    assert.equal(inspectTask({ cwd: f.root, operation: 'read', path: 'source.txt' }).text, 'fixture\n');
    assert.match(inspectTask({ cwd: f.root, operation: 'files' }).text, /module/u);
    assert.equal(inspectTask({ cwd: f.root, operation: 'status' }).text, '');
    const common = { session_id: 'submodule-client', turn_id: 'request', cwd: f.root };
    const prompt = handleCodexHook(db, { ...common, hook_event_name: 'UserPromptSubmit' }) as any;
    assert.match(prompt.hookSpecificOutput.additionalContext, /operation.*skill/u);
    const requestId = db.prepare('SELECT request_id FROM codex_hook_requests').get<{ request_id: string }>()!.request_id;
    const args = { cwd: f.root, requestId, soulRead: true as const, task: 'Fix preparation with uninitialized submodules', capabilities,
      profileHints: { taskType: 'debug' as const, target: 'source.txt', expected: 'Preparation proceeds', constraints: 'Do not initialize submodules' } };
    const prepared = await prepareAgentTask(db, { ...args, skillDiscoveryMode: 'off' });
    assert.equal(prepared.nextAction, 'proceed');
    handleCodexHook(db, { ...common, hook_event_name: 'PostToolUse', tool_name: 'mcp__kiokuko__task_prepare', tool_use_id: 'prepare', tool_input: args, tool_response: { structuredContent: prepared } });
    const event = { ...common, tool_name: 'exec_command', tool_use_id: 'read', tool_input: { cmd: 'cat source.txt' } };
    assert.deepEqual(handleCodexHook(db, { ...event, hook_event_name: 'PreToolUse' }), {});
    assert.match((handleCodexHook(db, { ...event, hook_event_name: 'PostToolUse', tool_response: { exit_code: 0 } }) as any).hookSpecificOutput.additionalContext, /outcome: passed/u);
    assert.deepEqual(readdirSync(path.join(f.root, 'module')), []);
    rmSync(path.join(f.root, 'module'), { recursive: true });
    assert.equal(repositoryStateDigest(f.root), digest);
    mkdirSync(path.join(f.root, 'module'));
    writeFileSync(path.join(f.root, 'module', 'unexpected.txt'), 'unverifiable\n');
    assert.throws(() => repositoryStateDigest(f.root), /Uninitialized submodule contains files/u);
    rmSync(path.join(f.root, 'module', 'unexpected.txt'));
    git(f.root, 'submodule', 'update', '--init');
    const partiallyInitialized = repositoryStateDigest(f.root);
    assert.notEqual(partiallyInitialized, digest);
    assert.deepEqual(readdirSync(path.join(f.root, 'module', 'nested')), []);
    git(f.root, 'submodule', 'update', '--init', '--recursive');
    const initialized = repositoryStateDigest(f.root);
    assert.notEqual(initialized, digest);
    writeFileSync(path.join(f.root, 'module', 'nested', 'source.txt'), 'changed\n');
    assert.notEqual(repositoryStateDigest(f.root), initialized);
  } finally { db.close(); rmSync(f.base, { recursive: true, force: true }); }
});

test('Skill access needs no Git checkout and accepts names and bundled paths', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'kiokuko-skill-read-'));
  try {
    const text = inspectTask({ cwd, operation: 'skill' }).text;
    for (const skillPath of ['kiokuko-soul', 'kiokuko-soul/SKILL.md', 'skills/kiokuko-soul/SKILL.md', path.resolve('skills/kiokuko-soul/SKILL.md')]) {
      assert.equal(inspectTask({ cwd, operation: 'skill', path: skillPath }).text, text);
    }
    assert.throws(() => inspectTask({ cwd, operation: 'skill', path: '../package.json' }), /Skill/u);
    assert.throws(() => inspectTask({ cwd, operation: 'skill', path: 'kiokuko-soul/../../package.json' }), /Skill/u);
    assert.throws(() => inspectTask({ cwd, operation: 'skill', path: '/outside/kiokuko-soul/SKILL.md' }), /Skill/u);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('MCP preparation errors provide safe recovery guidance without exposing rejected paths', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'kiokuko-inspect-mcp-'));
  const cwd = path.join(base, 'repo');
  mkdirSync(cwd);
  git(cwd, 'init', '-q');
  const server = createKiokukoMcpServer({ cwd: () => cwd });
  const client = new Client({ name: 'inspection-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st); await client.connect(ct);
  try {
    const soul = await client.callTool({ name: 'task_inspect', arguments: { cwd, operation: 'skill' } });
    assert.notEqual(soul.isError, true);
    const rejected = await client.callTool({ name: 'task_inspect', arguments: { cwd, operation: 'skill', path: '/private-secret/kiokuko-soul/SKILL.md' } });
    assert.equal(rejected.isError, true);
    assert.equal((rejected.structuredContent as any).recoverable, true);
    assert.equal((rejected.structuredContent as any).retryable, false);
    assert.equal((rejected.structuredContent as any).reason, 'skill');
    assert.match(JSON.stringify(rejected), /omit path/u);
    assert.doesNotMatch(JSON.stringify(rejected), /private-secret/u);
    const missing = await client.callTool({ name: 'task_inspect', arguments: { cwd, operation: 'read', path: 'missing.txt' } });
    assert.equal((missing.structuredContent as any).code, 'NOT_FOUND');
    writeFileSync(path.join(base, 'secret.txt'), 'must not be read');
    const outside = path.join(cwd, 'outside');
    symlinkSync(base, outside);
    const escaped = await client.callTool({ name: 'task_inspect', arguments: { cwd, operation: 'read', path: 'outside/secret.txt' } });
    assert.equal(escaped.isError, true);
    assert.equal((escaped.structuredContent as any).code, 'VALIDATION_ERROR');
    assert.doesNotMatch(JSON.stringify(escaped), /must not be read/u);
    writeFileSync(path.join(cwd, 'source.txt'), 'inside');
    assert.equal(inspectTask({ cwd, operation: 'read', path: path.join(cwd, 'source.txt') }).text, 'inside');
    assert.throws(() => inspectTask({ cwd, operation: 'read', path: '../secret' }));
    assert.throws(() => inspectTask({ cwd, operation: 'read', path: '.git/config' }));
    assert.throws(() => inspectTask({ cwd, operation: 'read', path: '.env' }));
    writeFileSync(path.join(cwd, '.env'), 'secret');
    symlinkSync('.env', path.join(cwd, 'disguised.txt'));
    assert.throws(() => inspectTask({ cwd, operation: 'read', path: 'disguised.txt' }), /allowed directory/u);
  } finally { await client.close(); await server.close(); rmSync(base, { recursive: true, force: true }); }
});
