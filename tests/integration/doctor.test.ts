import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { buildCli } from '../../src/cli.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { useRepository } from '../../src/commands/use.js';
import { renderManagedBlock } from '../../src/agent-file/render.js';
import { openConnection, SqliteVecLoadError } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { parseEmbeddingConfig, requireEnabledEmbeddingConfig } from '../../src/embedding/config.js';
import { LOCAL_SMALL_PRESET } from '../../src/embedding/presets/local-small.js';
import { createEmbeddingProfile, createLocalEmbeddingProfile } from '../../src/embedding/profile.js';
import { activateEmbeddingProfile, activateLocalEmbeddingProfile } from '../../src/embedding/store.js';
import {
  findMissingRepositoryLocations,
  registerRepositoryAndLocation,
  removeMissingRepositoryLocations,
} from '../../src/repository/binding.js';

async function temporaryDatabase(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), `kiokuko-doctor-${prefix}-`));
  const databasePath = path.join(directory, 'kiokuko.sqlite3');
  const database = openConnection(databasePath);
  migrateDatabase(database);
  return { database, databasePath, directory };
}

function register(database: ReturnType<typeof openConnection>, name: string, canonicalRoot: string): void {
  registerRepositoryAndLocation(database, {
    repositoryId: `repo_doctor_${name}`,
    workspace: `project:doctor-${name}`,
    displayName: name,
    canonicalRoot,
    remoteFingerprint: null,
    bindingSchemaVersion: 1,
    agentTemplateVersion: 1,
  });
}

function locationCount(database: ReturnType<typeof openConnection>): number {
  return Number(database.prepare('SELECT COUNT(*) AS count FROM repository_locations').get<{ count: number }>()?.count ?? 0);
}

function ttyOutput(onWrite?: (text: string) => void): Writable & { isTTY?: boolean; text: string } {
  let text = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      onWrite?.(chunk.toString());
      callback();
    },
  }) as Writable & { isTTY?: boolean; text: string };
  output.isTTY = true;
  Object.defineProperty(output, 'text', { get: () => text });
  return output;
}

async function invokeDoctor(
  databasePath: string,
  answer: string,
  json = false,
  interactive = true,
  onQuestion?: () => Promise<void>,
  closeInputOnQuestion = false,
): Promise<{ stdout: string; prompt: string; exitCode: number | undefined; response?: { data: Record<string, unknown>; ok: boolean } }> {
  let stdout = '';
  const originalWrite = process.stdout.write;
  const previousExitCode = process.exitCode;
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = interactive;
  const answers = answer.split('\n');
  const output = ttyOutput((chunk) => {
    if (/\? \[(?:Y\/n|y\/N)\]/u.test(chunk)) {
      void (async () => {
        await onQuestion?.();
        if (closeInputOnQuestion) { input.end(); return; }
        input.write(`${answers.shift() ?? ''}\n`);
      })();
    }
  });
  let exitCode: number | undefined;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
  try {
    await buildCli({
      doctorDatabasePath: databasePath,
      doctorInput: input,
      doctorOutput: output,
    }).parseAsync(['node', 'kiokuko', 'doctor', ...(json ? ['--json'] : [])]);
    exitCode = process.exitCode === undefined ? undefined : Number(process.exitCode);
  } finally {
    input.end();
    process.stdout.write = originalWrite;
    process.exitCode = previousExitCode;
  }
  return {
    stdout,
    prompt: output.text,
    exitCode,
    ...(json ? { response: JSON.parse(stdout) as { data: Record<string, unknown>; ok: boolean } } : {}),
  };
}

async function deletedAgentProject(prefix: string, agentFile = 'AGENTS.md') {
  const value = await temporaryDatabase(prefix);
  value.database.close();
  const root = path.join(value.directory, 'project');
  await mkdir(path.dirname(path.join(root, agentFile)), { recursive: true });
  const project = await useRepository({ root, agentFile, allowDirectory: true, databasePath: value.databasePath });
  await unlink(project.agentFile!);
  return { ...value, project };
}

test('doctor adds its missing plugin section without treating foreign ownership as malformed', async () => {
  const value = await deletedAgentProject('foreign-agent');
  const foreign = 'User rules\r\n<!-- BEGIN KIOKUKO-AI MANAGED BLOCK -->\r\nForeign rules\r\n<!-- END KIOKUKO-AI MANAGED BLOCK -->\r\n';
  await writeFile(value.project.agentFile!, foreign);
  const diagnostic = await invokeDoctor(value.databasePath, 'y\n', true);
  const findings = (diagnostic.response?.data.checks as { agentFiles: { findings: Array<{ reason: string }> } }).agentFiles.findings;
  assert.equal(findings[0]?.reason, 'missing_managed_block');
  assert.equal(await readFile(value.project.agentFile!, 'utf8'), foreign);
  const declined = await invokeDoctor(value.databasePath, 'n\n');
  assert.equal(await readFile(value.project.agentFile!, 'utf8'), foreign);
  assert.equal(declined.exitCode, 8);
  const repaired = await invokeDoctor(value.databasePath, 'y\n');
  assert.match(repaired.prompt, /Repair this Kiokuko section\? \[y\/N\]/u);
  assert.equal(repaired.exitCode, undefined);
  const content = await readFile(value.project.agentFile!, 'utf8');
  assert.ok(content.startsWith(foreign));
  assert.match(content, /Only the Kiokuko plugin may apply/u);
  assert.equal((await invokeDoctor(value.databasePath, 'y\n')).prompt, '');
});

test('doctor repairs alongside a legacy DSH section and the next run is healthy', async () => {
  const value = await deletedAgentProject('legacy-dsh');
  const foreign = 'Human rules\r\n<!-- BEGIN KIOKUKO MANAGED BLOCK -->\r\n<!-- kiokuko-dsh-template-version: 1 -->\r\nDSH instructions\r\n<!-- END KIOKUKO MANAGED BLOCK -->\r\nFooter\r\n';
  await writeFile(value.project.agentFile!, foreign);
  const diagnostic = await invokeDoctor(value.databasePath, '', true);
  const findings = (diagnostic.response?.data.checks as { agentFiles: { findings: Array<{ reason: string }> } }).agentFiles.findings;
  assert.equal(findings[0]?.reason, 'missing_managed_block');
  assert.equal(await readFile(value.project.agentFile!, 'utf8'), foreign);
  const result = await invokeDoctor(value.databasePath, 'y\n');
  assert.match(result.prompt, /Repair this Kiokuko section/u);
  assert.match(result.stdout, /Kiokuko doctor: OK/u);
  const repaired = await readFile(value.project.agentFile!, 'utf8');
  assert.ok(repaired.startsWith(foreign));
  const repeated = await invokeDoctor(value.databasePath, '');
  assert.equal(repeated.prompt, '');
  assert.equal(repeated.exitCode, undefined);
  assert.match(repeated.stdout, /Kiokuko doctor: OK/u);
  assert.equal(await readFile(value.project.agentFile!, 'utf8'), repaired);
});

test('human doctor reports the path and reason of unrepaired agent findings', async () => {
  const value = await deletedAgentProject('unrepairable-detail');
  const malformed = 'Human rules\n<!-- BEGIN KIOKUKO MANAGED BLOCK -->\n';
  await writeFile(value.project.agentFile!, malformed);
  const result = await invokeDoctor(value.databasePath, 'y\n');
  assert.ok(result.stdout.includes(value.project.agentFile!));
  assert.match(result.stdout, /invalid_managed_block/u);
  assert.equal(result.prompt, '');
  assert.equal(result.exitCode, 8);
  assert.equal(await readFile(value.project.agentFile!, 'utf8'), malformed);
});

test('doctor offers legacy section migration and rejects concurrent repair changes', async () => {
  const value = await deletedAgentProject('legacy-agent');
  const legacy = 'before\n<!-- BEGIN KIOKUKO MANAGED BLOCK -->\n<!-- kiokuko-template-version: 36 -->\nOld Kiokuko instructions\n<!-- END KIOKUKO MANAGED BLOCK -->\nafter';
  await writeFile(value.project.agentFile!, legacy);
  const result = await invokeDoctor(value.databasePath, 'y\n');
  assert.equal(result.exitCode, undefined);
  const content = await readFile(value.project.agentFile!, 'utf8');
  assert.ok(content.startsWith('before\n') && content.endsWith('\nafter'));
  assert.match(content, /Only the Kiokuko plugin may apply/u);
  await writeFile(value.project.agentFile!, legacy);
  await assert.rejects(invokeDoctor(value.databasePath, 'y\n', false, true, async () => {
    await writeFile(value.project.agentFile!, 'concurrent user rules\n');
  }), { code: 'CONFLICT' });
  assert.equal(await readFile(value.project.agentFile!, 'utf8'), 'concurrent user rules\n');
});

test('doctor rejects reversed and inline markers and preserves newer templates', async () => {
  const value = await deletedAgentProject('invalid-markers');
  for (const content of [
    '<!-- END KIOKUKO MANAGED BLOCK -->\n<!-- BEGIN KIOKUKO MANAGED BLOCK -->',
    'human <!-- BEGIN KIOKUKO MANAGED BLOCK -->\n<!-- END KIOKUKO MANAGED BLOCK -->',
    renderManagedBlock({ repositoryId: value.project.repositoryId, workspace: value.project.workspace, cliCommand: 'kiokuko', templateVersion: 999 }),
  ]) {
    await writeFile(value.project.agentFile!, content);
    const diagnostic = await invokeDoctor(value.databasePath, 'y\n', true);
    assert.equal(diagnostic.response?.data.ok, false);
    const interactive = await invokeDoctor(value.databasePath, 'y\n');
    assert.equal(interactive.prompt, '');
    assert.equal(await readFile(value.project.agentFile!, 'utf8'), content);
  }
});

test('interactive doctor asks before recreating a deleted configured agent file and reruns health checks', async () => {
  const value = await deletedAgentProject('agent-create', 'instructions/AGENTS.md');
  const bindingBefore = await readFile(value.project.bindingFile, 'utf8');
  const result = await invokeDoctor(value.databasePath, 'y\n');
  assert.ok(result.prompt.includes(value.project.agentFile!));
  assert.match(result.prompt, /Create this missing agent file\? \[y\/N\]/u);
  assert.match(result.stdout, /Kiokuko doctor: OK/u);
  assert.equal(result.exitCode, undefined);
  const restored = await readFile(value.project.agentFile!, 'utf8');
  assert.ok(restored.includes(value.project.repositoryId));
  assert.ok(restored.includes(value.project.workspace));
  assert.equal(await readFile(value.project.bindingFile, 'utf8'), bindingBefore);
  const repeated = await invokeDoctor(value.databasePath, 'y\n');
  assert.equal(repeated.prompt, '');
  assert.equal(await readFile(value.project.agentFile!, 'utf8'), restored);
});

test('agent recreation never overwrites a file created during confirmation', async () => {
  const value = await deletedAgentProject('agent-race');
  await assert.rejects(invokeDoctor(value.databasePath, 'y\n', false, true, async () => {
    await writeFile(value.project.agentFile!, 'concurrent user instructions\n');
  }), { code: 'CONFLICT' });
  assert.equal(await readFile(value.project.agentFile!, 'utf8'), 'concurrent user instructions\n');
});

test('agent recreation rejects a binding changed during confirmation', async () => {
  const value = await deletedAgentProject('binding-race');
  await assert.rejects(invokeDoctor(value.databasePath, 'y\n', false, true, async () => {
    const config = JSON.parse(await readFile(value.project.bindingFile, 'utf8')) as Record<string, unknown>;
    await writeFile(value.project.bindingFile, `${JSON.stringify({ ...config, agentFile: 'OTHER.md' })}\n`);
  }), { code: 'CONFLICT' });
  await assert.rejects(access(value.project.agentFile!));
  await assert.rejects(access(path.join(value.project.repositoryRoot, 'OTHER.md')));
});

test('closing input during agent confirmation returns without recreating the file', async () => {
  const value = await deletedAgentProject('agent-eof');
  const result = await invokeDoctor(value.databasePath, '', false, true, undefined, true);
  assert.match(result.prompt, /Create this missing agent file\?/u);
  assert.equal(result.exitCode, 8);
  await assert.rejects(access(value.project.agentFile!));
});

test('doctor asks separately for multiple missing agent files', async () => {
  const value = await deletedAgentProject('agent-multiple');
  const otherRoot = path.join(value.directory, 'other-project');
  await mkdir(otherRoot);
  const other = await useRepository({ root: otherRoot, allowDirectory: true, databasePath: value.databasePath });
  await unlink(other.agentFile!);
  const result = await invokeDoctor(value.databasePath, 'n\ny\n');
  assert.equal(result.prompt.split('Create this missing agent file?').length - 1, 2);
  // The registry scans canonical roots in order: other-project first, then project.
  await assert.rejects(access(other.agentFile!));
  assert.ok((await readFile(value.project.agentFile!, 'utf8')).includes(value.project.workspace));
  assert.equal(result.exitCode, 8);
});

for (const answer of ['n\n', '\n']) {
  test(`declining agent recreation preserves the deleted file (${JSON.stringify(answer)})`, async () => {
    const value = await deletedAgentProject('agent-decline');
    const result = await invokeDoctor(value.databasePath, answer);
    assert.match(result.prompt, /Create this missing agent file\? \[y\/N\]/u);
    assert.match(result.stdout, /Kiokuko doctor: FAILED/u);
    assert.equal(result.exitCode, 8);
    await assert.rejects(access(value.project.agentFile!));
  });
}

test('JSON doctor reports the missing configured agent path without prompting or creating it', async () => {
  const value = await deletedAgentProject('agent-json');
  const result = await invokeDoctor(value.databasePath, 'y\n', true);
  assert.equal(result.prompt, '');
  assert.equal(result.response?.ok, true);
  assert.equal(result.response?.data.ok, false);
  assert.deepEqual((result.response?.data.checks as Record<string, unknown>).agentFiles, {
    ok: false,
    count: 1,
    findings: [{
      repositoryRoot: value.project.repositoryRoot,
      repositoryId: value.project.repositoryId,
      agentFile: value.project.agentFile,
      reason: 'missing_agent_file',
    }],
  });
  assert.equal(result.exitCode, 8);
  await assert.rejects(access(value.project.agentFile!));
});

test('noninteractive doctor leaves deleted instructions absent', async () => {
  const value = await deletedAgentProject('agent-nontty');
  const result = await invokeDoctor(value.databasePath, 'y\n', false, false);
  assert.equal(result.prompt, '');
  assert.match(result.stdout, /Kiokuko doctor: FAILED/u);
  assert.equal(result.exitCode, 8);
  await assert.rejects(access(value.project.agentFile!));
});

test('doctor never offers to recreate an existing malformed agent file or invalid binding', async () => {
  const value = await deletedAgentProject('agent-invalid');
  const content = 'user rules\n<!-- BEGIN KIOKUKO MANAGED BLOCK -->\n';
  await writeFile(value.project.agentFile!, content);
  const result = await invokeDoctor(value.databasePath, 'y\n');
  assert.equal(result.prompt, '');
  assert.match(result.stdout, /Kiokuko doctor: FAILED/u);
  assert.equal(await readFile(value.project.agentFile!, 'utf8'), content);
  await unlink(value.project.agentFile!);
  await writeFile(value.project.bindingFile, '{}\n');
  const invalid = await invokeDoctor(value.databasePath, 'y\n');
  assert.equal(invalid.prompt, '');
  assert.match(invalid.stdout, /Kiokuko doctor: FAILED/u);
  await assert.rejects(access(value.project.agentFile!));
});

test('doctor treats dangling agent symlinks as unsafe files rather than missing creation targets', async () => {
  const value = await deletedAgentProject('agent-symlink');
  await symlink(path.join(value.directory, 'missing-target'), value.project.agentFile!);
  const result = await invokeDoctor(value.databasePath, 'y\n', true);
  const finding = (result.response?.data.checks as { agentFiles: { findings: Array<{ reason: string }> } }).agentFiles.findings[0];
  assert.equal(finding?.reason, 'unreadable_agent_file');
  const interactive = await invokeDoctor(value.databasePath, 'y\n');
  assert.equal(interactive.prompt, '');
  assert.equal(interactive.exitCode, 8);
});

test('missing-location cleanup removes only absent location rows and preserves repositories', async () => {
  const value = await temporaryDatabase('rows');
  const liveRoot = path.join(value.directory, 'live');
  const missingRoot = path.join(value.directory, 'missing');
  await mkdir(liveRoot);
  try {
    register(value.database, 'live', liveRoot);
    register(value.database, 'missing', missingRoot);
    const candidates = findMissingRepositoryLocations(value.database);
    assert.deepEqual(candidates.map((location) => location.canonicalRoot), [missingRoot]);

    const removed = removeMissingRepositoryLocations(value.database, candidates);
    assert.equal(removed, 1);
    assert.equal(locationCount(value.database), 1);
    assert.equal(
      Number(value.database.prepare('SELECT COUNT(*) AS count FROM repositories').get<{ count: number }>()?.count ?? 0),
      2,
    );
    assert.equal(findMissingRepositoryLocations(value.database).length, 0);
  } finally {
    value.database.close();
  }
});

test('missing-location cleanup rechecks a root before deleting its registry row', async () => {
  const value = await temporaryDatabase('race');
  const root = path.join(value.directory, 'restored');
  try {
    register(value.database, 'restored', root);
    const candidates = findMissingRepositoryLocations(value.database);
    await mkdir(root);
    assert.equal(removeMissingRepositoryLocations(value.database, candidates), 0);
    assert.equal(locationCount(value.database), 1);
  } finally {
    value.database.close();
  }
});

test('interactive doctor removes confirmed missing locations and reports the rerun result', async () => {
  const value = await temporaryDatabase('confirm');
  try {
    register(value.database, 'missing', path.join(value.directory, 'missing'));
  } finally {
    value.database.close();
  }

  const result = await invokeDoctor(value.databasePath, '\n');
  assert.match(result.prompt, /Remove these stale locations\? \[Y\/n\]/u);
  assert.match(result.stdout, /Kiokuko doctor: OK/u);
  assert.match(result.stdout, /Removed 1 missing repository location/u);

  const database = openConnection(value.databasePath);
  try {
    assert.equal(locationCount(database), 0);
  } finally {
    database.close();
  }
});

test('declining interactive doctor cleanup preserves missing locations', async () => {
  const value = await temporaryDatabase('decline');
  try {
    register(value.database, 'missing', path.join(value.directory, 'missing'));
  } finally {
    value.database.close();
  }

  const result = await invokeDoctor(value.databasePath, 'n\n');
  assert.match(result.prompt, /Remove these stale locations\? \[Y\/n\]/u);
  assert.match(result.stdout, /Kiokuko doctor: FAILED/u);
  assert.match(result.stdout, /Failed checks: bindings\./u);
  assert.match(result.stdout, /\nrun kiokuko doctor --json for detailed output/u);

  const database = openConnection(value.databasePath);
  try {
    assert.equal(locationCount(database), 1);
  } finally {
    database.close();
  }
});

test('JSON doctor never prompts or cleans missing locations', async () => {
  const value = await temporaryDatabase('json');
  try {
    register(value.database, 'missing', path.join(value.directory, 'missing'));
  } finally {
    value.database.close();
  }

  const result = await invokeDoctor(value.databasePath, 'y\n', true);
  assert.equal(result.prompt, '');
  assert.equal(result.response?.ok, true);
  assert.equal((result.response?.data.checks as { bindings: { ok: boolean } }).bindings.ok, false);

  const database = openConnection(value.databasePath);
  try {
    assert.equal(locationCount(database), 1);
  } finally {
    database.close();
  }
});

test('doctor uses persisted local embedding settings and reports the selected backend', async () => {
  const value = await temporaryDatabase('local-embeddings');
  const profile = createLocalEmbeddingProfile(LOCAL_SMALL_PRESET);
  try {
    activateLocalEmbeddingProfile(value.database, profile, {
      replace: false,
      now: '2026-08-31T00:00:00.000Z',
    });
    value.database.prepare(`
      UPDATE embedding_settings
         SET mode = 'optional', provider_kind = 'local-transformers',
             preset_id = 'local-small', vector_backend = 'auto',
             setup_state = 'ready', updated_at = ?
       WHERE singleton = 1
    `).run('2026-08-31T00:00:00.000Z');
  } finally {
    value.database.close();
  }

  const result = await runDoctor({
    databasePath: value.databasePath,
    runtimeDescriptorPath: path.join(value.directory, 'runtime', 'server.json'),
  });

  assert.deepEqual(result.checks.embeddings, {
    ok: true,
    count: 0,
    detail: 'findings=0, mode=optional, backend=sqlite-vec',
  });
});

test('doctor reports a forced sqlite-vec backend that cannot be loaded', async () => {
  const value = await temporaryDatabase('forced-sqlite-vec');
  const embeddingEnvironment = {
    KIOKUKO_EMBEDDINGS: 'optional',
    KIOKUKO_EMBEDDING_BASE_URL: 'http://127.0.0.1:8080/v1',
    KIOKUKO_EMBEDDING_MODEL: 'doctor-test',
    KIOKUKO_EMBEDDING_DIMENSIONS: '3',
    KIOKUKO_EMBEDDING_DISTANCE_CEILING: '0.8',
    KIOKUKO_VECTOR_BACKEND: 'sqlite-vec',
  } satisfies NodeJS.ProcessEnv;
  try {
    const config = requireEnabledEmbeddingConfig(parseEmbeddingConfig(embeddingEnvironment));
    activateEmbeddingProfile(value.database, createEmbeddingProfile(config), {
      replace: false,
      now: '2026-08-31T00:00:00.000Z',
    });
  } finally {
    value.database.close();
  }

  let extensionOpenAttempts = 0;
  const result = await runDoctor({
    databasePath: value.databasePath,
    runtimeDescriptorPath: path.join(value.directory, 'runtime', 'server.json'),
    embeddingEnvironment,
  }, {
    openConnection: (databasePath, options) => {
      if (options?.sqliteVecLoader !== undefined) {
        extensionOpenAttempts += 1;
        throw new SqliteVecLoadError('sqlite-vec unavailable in doctor test');
      }
      return openConnection(databasePath, options);
    },
  });

  assert.equal(extensionOpenAttempts, 1);
  assert.deepEqual(result.checks.embeddings, {
    ok: false,
    count: 1,
    detail: 'findings=1, mode=optional, backend=sqlite-vec',
  });
});

async function withDoctorEnvironment<T>(
  dataDirectory: string,
  codexHome: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previousDataDirectory = process.env.KIOKUKO_DATA_DIR;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.KIOKUKO_DATA_DIR = dataDirectory;
  process.env.CODEX_HOME = codexHome;
  try {
    return await operation();
  } finally {
    if (previousDataDirectory === undefined) delete process.env.KIOKUKO_DATA_DIR;
    else process.env.KIOKUKO_DATA_DIR = previousDataDirectory;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
  }
}

test('doctor reports an unmanaged Codex Kiokuko MCP identity', async () => {
  const value = await temporaryDatabase('codex-mcp-conflict');
  value.database.close();
  const codexHome = path.join(value.directory, 'codex-home');
  await mkdir(codexHome);
  await writeFile(
    path.join(codexHome, 'config.toml'),
    '[mcp_servers.kiokuko]\ncommand = "custom"\n',
  );

  const result = await withDoctorEnvironment(value.directory, codexHome, () => runDoctor());
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.codexMcp, {
    ok: false,
    count: 1,
    detail: 'config=conflict',
  });
});

test('doctor accepts the canonical Codex Kiokuko MCP identity', async () => {
  const value = await temporaryDatabase('codex-mcp-canonical');
  value.database.close();
  const codexHome = path.join(value.directory, 'codex-home');
  await mkdir(codexHome);
  await writeFile(
    path.join(codexHome, 'config.toml'),
    [
      '# BEGIN KIOKUKO MCP',
      '# Managed by `kiokuko setup`.',
      '[mcp_servers.kiokuko]',
      'command = "kiokuko"',
      'args = ["mcp"]',
      'enabled = true',
      'required = true',
      'env = { KIOKUKO_SKILL_DISCOVERY = "official" }',
      '# END KIOKUKO MCP',
      '',
    ].join('\n'),
  );

  const result = await withDoctorEnvironment(value.directory, codexHome, () => runDoctor());
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.codexMcp, {
    ok: true,
    count: 0,
    detail: 'config=canonical-or-not-configured',
  });
});
