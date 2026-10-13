import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { KiokukoError } from '../errors.js';

interface FileRecord { path: string; sha256: string; mode: number; }
export interface RuntimeManifest {
  schema: 1;
  runtimeId: string;
  packageVersion: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  files: FileRecord[];
}
export interface PreparedRuntime { runtimeId: string; root: string; manifestPath: string; nodePath: string; cliPath: string; }
const sourcePackage = fileURLToPath(new URL('../../package.json', import.meta.url));
const sourceRoot = path.dirname(sourcePackage);
const topLevelFiles = new Set(['dist', 'migrations', 'skills', 'templates', 'docs', 'package.json', 'README.md', 'README.ja.md', 'README.ko.md', 'README.zh-CN.md', 'LICENSE']);

function invalid(message: string): never { throw new KiokukoError('INTEGRITY_ERROR', message); }
function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
async function hash(file: string): Promise<string> {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
async function regular(file: string): Promise<void> {
  const info = await lstat(file);
  if (!info.isFile()) invalid(`Runtime source is not a regular file: ${file}`);
}
function defaultRoot(): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Kiokuko', 'runtimes');
  const xdg = process.env.XDG_DATA_HOME;
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.local', 'share'), 'kiokuko', 'runtimes');
}
async function runtimeRoot(requested?: string): Promise<string> {
  const root = requested ?? defaultRoot();
  if (!path.isAbsolute(root)) throw new KiokukoError('VALIDATION_ERROR', 'Runtime root must be absolute');
  const source = await realpath(sourceRoot);
  const home = await realpath(os.homedir());
  const cwd = process.cwd();
  const forbidden = [source, ...(existsSync(path.join(cwd, '.git')) ? [cwd] : []), path.join(home, 'Documents'), path.join(home, 'Library', 'Mobile Documents')];
  if (forbidden.some(candidate => inside(candidate, root))) throw new KiokukoError('VALIDATION_ERROR', 'Runtime root is inside a package, repository, Documents, or iCloud directory');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonical = await realpath(root);
  if (forbidden.some(candidate => inside(candidate, canonical))) throw new KiokukoError('VALIDATION_ERROR', 'Runtime root is inside a package, repository, Documents, or iCloud directory');
  const info = await lstat(canonical);
  if ((info.mode & 0o077) !== 0) throw new KiokukoError('VALIDATION_ERROR', 'Runtime root must be private to the user');
  return canonical;
}
async function filesUnder(root: string, selected?: Set<string>, skipDependencies = true): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string, relative: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if ((skipDependencies && entry.name === 'node_modules') || entry.name === '.git') continue;
      if (!relative && selected && !selected.has(entry.name)) continue;
      const subpath = relative ? path.join(relative, entry.name) : entry.name;
      const source = path.join(root, subpath);
      const info = await lstat(source);
      if (info.isSymbolicLink()) invalid(`Runtime source contains a symbolic link: ${source}`);
      if (info.isDirectory()) await visit(source, subpath);
      else if (info.isFile()) result.push(subpath);
      else invalid(`Runtime source contains a non-file: ${source}`);
    }
  }
  await visit(root, '');
  return result;
}
async function copyChecked(source: string, destination: string, logical: string, records: FileRecord[], origins: Map<string, string>): Promise<void> {
  await regular(source);
  const before = await hash(source);
  const mode = ((await lstat(source)).mode & 0o111) === 0 ? 0o400 : 0o500;
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  await chmod(destination, mode);
  if (before !== await hash(source) || before !== await hash(destination)) invalid(`Runtime source changed during copy: ${source}`);
  origins.set(source, before);
  records.push({ path: logical, sha256: before, mode });
}
async function installedDependency(from: string, name: string): Promise<{ source: string; base: string } | undefined> {
  for (let base = from; ; base = path.dirname(base)) {
    const candidate = path.join(base, 'node_modules', ...name.split('/'));
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) invalid(`Dependency is a symbolic link: ${candidate}`);
      if (!info.isDirectory()) invalid(`Dependency is not a directory: ${candidate}`);
      await regular(path.join(candidate, 'package.json'));
      return { source: candidate, base };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (base === path.dirname(base)) return undefined;
  }
}
async function copyPackageGraph(stage: string, records: FileRecord[], origins: Map<string, string>): Promise<string> {
  const app = path.join(stage, 'app');
  const locations = new Map<string, string>([[sourceRoot, app]]);
  const destinations = new Map<string, string>();
  async function visit(source: string, destination: string, top: boolean): Promise<void> {
    const existing = destinations.get(destination);
    if (existing !== undefined) {
      if (existing !== source) invalid(`Different dependencies resolve to one runtime location: ${destination}`);
      return;
    }
    destinations.set(destination, source);
    locations.set(source, destination);
    const names = await filesUnder(source, top ? topLevelFiles : undefined);
    if (!names.includes('package.json')) invalid(`Dependency lacks package.json: ${source}`);
    for (const name of names) {
      const target = path.join(destination, name);
      await copyChecked(path.join(source, name), target, path.relative(stage, target), records, origins);
    }
    const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    const namesToResolve = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})]);
    for (const name of [...namesToResolve].sort()) {
      const found = await installedDependency(source, name);
      const optional = name in (pkg.optionalDependencies ?? {}) || pkg.peerDependenciesMeta?.[name]?.optional === true;
      if (!found) {
        if (optional) continue;
        invalid(`Required installed dependency is missing: ${name} (from ${source})`);
      }
      const installed = JSON.parse(await readFile(path.join(found.source, 'package.json'), 'utf8')) as { name?: string };
      if (installed.name !== name) invalid(`Installed dependency has the wrong package identity: ${name}`);
      const baseDestination = locations.get(found.base) ?? app;
      await visit(found.source, path.join(baseDestination, 'node_modules', ...name.split('/')), false);
    }
    const after = await filesUnder(source, top ? topLevelFiles : undefined);
    if (JSON.stringify(after) !== JSON.stringify(names)) invalid(`Runtime source file list changed during copy: ${source}`);
  }
  await visit(sourceRoot, app, true);
  return app;
}
function manifestId(value: Omit<RuntimeManifest, 'runtimeId'>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
async function withinStartupDeadline<T>(work: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${phase} timed out`)), 15_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
async function smokePreparedRuntime(stage: string, runtimeId: string): Promise<void> {
  const node = path.join(stage, 'node');
  const cli = path.join(stage, 'app', 'dist', 'bin', 'kiokuko.js');
  const home = path.join(stage, '.smoke-home');
  await mkdir(home, { mode: 0o700 });
  const env = { HOME: home, KIOKUKO_DATA_DIR: path.join(home, 'data'), PATH: '' };
  const client = new Client({ name: 'kiokuko-runtime-prepare', version: '1' });
  try {
    const transport = new StdioClientTransport({ command: node, args: [cli, 'mcp'], cwd: home, env, stderr: 'pipe' });
    await withinStartupDeadline(client.connect(transport), 'MCP startup');
    const tools = await withinStartupDeadline(client.listTools(), 'MCP tool listing');
    if (!tools.tools.some(tool => tool.name === 'task_prepare')) invalid(`Copied MCP startup failed (runtime ${runtimeId})`);
    if (recordsContainSqliteVec(stage)) {
      const moduleUrl = pathToFileURL(path.join(stage, 'app', 'dist', 'embedding', 'sqlite-vec-loader.js')).href;
      const script = `import { DatabaseSync } from 'node:sqlite'; import { createSqliteVecLoader } from ${JSON.stringify(moduleUrl)}; const loader = await createSqliteVecLoader(); if (!loader) process.exit(9); const db = new DatabaseSync(':memory:', { allowExtension: true }); loader.load(db); if (typeof db.prepare('select vec_version() as version').get().version !== 'string') process.exit(10); db.close();`;
      const native = spawnSync(node, ['--input-type=module', '--eval', script], { env, encoding: 'utf8', timeout: 15_000 });
      if (native.status !== 0) invalid(`Copied SQLite extension failed on first load (runtime ${runtimeId}, status ${native.status ?? 'unknown'})`);
    }
  } catch (error) {
    invalid(`Copied runtime startup failed (runtime ${runtimeId}): ${error instanceof Error ? error.message : 'unknown error'}`);
  } finally {
    await client.close();
    await rm(home, { recursive: true, force: true });
  }
}
function recordsContainSqliteVec(stage: string): boolean {
  return existsSync(path.join(stage, 'app', 'node_modules', 'sqlite-vec', 'package.json'));
}
export async function verifyPreparedRuntime(manifestPath: string): Promise<PreparedRuntime> {
  const root = path.dirname(manifestPath);
  if (path.basename(manifestPath) !== 'manifest.json' || await realpath(root) !== path.resolve(root)) invalid('Runtime manifest must be in a fixed directory, not a link');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as RuntimeManifest;
  const { runtimeId, ...body } = manifest;
  if (manifest.schema !== 1 || !/^[0-9a-f]{64}$/u.test(runtimeId) || manifestId(body) !== runtimeId || path.basename(root) !== runtimeId) invalid('Runtime manifest identity is invalid');
  for (const file of manifest.files) {
    if (!file.path || path.isAbsolute(file.path) || !inside(root, path.resolve(root, file.path))) invalid('Runtime manifest path is invalid');
    const target = path.resolve(root, file.path);
    await regular(target);
    if (await hash(target) !== file.sha256 || ((await lstat(target)).mode & 0o777) !== file.mode) invalid(`Runtime file is damaged: ${file.path}`);
  }
  const actual = (await filesUnder(root, undefined, false)).filter(file => file !== 'manifest.json').sort();
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files.map(file => file.path).sort())) invalid('Runtime file list differs from manifest');
  return { runtimeId, root, manifestPath, nodePath: path.join(root, 'node'), cliPath: path.join(root, 'app', 'dist', 'bin', 'kiokuko.js') };
}
export async function prepareRuntime(requestedRoot?: string, nodeExecutable = process.execPath): Promise<PreparedRuntime> {
  const root = await runtimeRoot(requestedRoot);
  const stage = await mkdtemp(path.join(root, '.prepare-'));
  try {
    const records: FileRecord[] = [];
    const origins = new Map<string, string>();
    await copyChecked(await realpath(nodeExecutable), path.join(stage, 'node'), 'node', records, origins);
    await copyPackageGraph(stage, records, origins);
    for (const [source, digest] of origins) if (await hash(source) !== digest) invalid(`Runtime source changed during preparation: ${source}`);
    records.sort((a, b) => a.path.localeCompare(b.path));
    const pkg = JSON.parse(await readFile(path.join(stage, 'app', 'package.json'), 'utf8')) as { version: string };
    const nodeVersionResult = spawnSync(path.join(stage, 'node'), ['--version'], { encoding: 'utf8', timeout: 10_000 });
    if (nodeVersionResult.status !== 0 || !/^v\d+\.\d+\.\d+\s*$/u.test(nodeVersionResult.stdout)) invalid('Copied Node cannot start independently; use --node with a standalone Node executable');
    const body = { schema: 1 as const, packageVersion: pkg.version, nodeVersion: nodeVersionResult.stdout.trim().slice(1), platform: process.platform, arch: process.arch, files: records };
    const runtimeId = manifestId(body);
    const manifest: RuntimeManifest = { ...body, runtimeId };
    await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    const cli = path.join(stage, 'app', 'dist', 'bin', 'kiokuko.js');
    const smoke = spawnSync(path.join(stage, 'node'), [cli, 'version'], { encoding: 'utf8', timeout: 30_000, env: { PATH: '', HOME: stage } });
    if (smoke.status !== 0 || smoke.stdout.trim() !== pkg.version) invalid(`Copied runtime failed before CLI readiness (runtime ${runtimeId}, status ${smoke.status ?? 'unknown'}, signal ${smoke.signal ?? 'none'})`);
    await smokePreparedRuntime(stage, runtimeId);
    for (const [source, digest] of origins) if (await hash(source) !== digest) invalid(`Runtime source changed before publication: ${source}`);
    const final = path.join(root, runtimeId);
    const lockPath = path.join(root, `.${runtimeId}.lock`);
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 300 && lock === undefined; attempt += 1) {
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let published = false;
        try { await lstat(final); published = true; }
        catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
        if (published) return verifyPreparedRuntime(path.join(final, 'manifest.json'));
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    if (lock === undefined) throw new KiokukoError('CONFLICT', 'Another runtime creation is still in progress');
    try {
      try { await lstat(final); return await verifyPreparedRuntime(path.join(final, 'manifest.json')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rename(stage, final);
      return verifyPreparedRuntime(path.join(final, 'manifest.json'));
    } finally {
      await lock.close();
      await rm(lockPath);
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
