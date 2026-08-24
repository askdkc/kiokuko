import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { SqliteDatabase } from '../db/adapter.js';
import type { ResolvedProjectWorkspace } from '../memory/workspaces.js';

export interface ProjectFingerprint {
  repositoryId: string;
  languages: string[];
  frameworks: Array<{ name: string; version?: string }>;
  databases: string[];
  runtimes: string[];
  tools: string[];
  packages: Array<{ name: string; version?: string }>;
  manifestDigest: string;
}

interface Manifest {
  name: string;
  text: string;
  value: Record<string, unknown> | null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function versionOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const match = value.match(/\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/u);
  return match?.[0];
}

function dependencies(value: Record<string, unknown> | null): Map<string, string | undefined> {
  const result = new Map<string, string | undefined>();
  for (const section of ['require', 'require-dev', 'dependencies', 'devDependencies', 'peerDependencies'] as const) {
    const input = value?.[section];
    if (typeof input !== 'object' || input === null || Array.isArray(input)) continue;
    for (const [name, version] of Object.entries(input as Record<string, unknown>)) result.set(name, versionOf(version));
  }
  return result;
}

function parseManifest(root: string, name: string): Manifest | undefined {
  const filePath = path.join(root, name);
  try {
    const text = readFileSync(filePath, 'utf8');
    let value: Record<string, unknown> | null = null;
    if (name.endsWith('.json')) {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
    }
    return { name, text, value };
  } catch {
    return undefined;
  }
}

function addDependencyPackages(packages: Array<{ name: string; version?: string }>, input: Map<string, string | undefined>): void {
  for (const [name, version] of input) packages.push({ name, ...(version === undefined ? {} : { version }) });
}

function addFrameworks(frameworks: Array<{ name: string; version?: string }>, input: Map<string, string | undefined>, mappings: Array<[string, string]>): void {
  for (const [packageName, frameworkName] of mappings) {
    const version = input.get(packageName);
    if (version !== undefined || input.has(packageName)) frameworks.push({ name: frameworkName, ...(version === undefined ? {} : { version }) });
  }
}

function rawFingerprint(repositoryId: string, manifests: Manifest[]): ProjectFingerprint {
  const languages: string[] = [];
  const frameworks: Array<{ name: string; version?: string }> = [];
  const databases: string[] = [];
  const runtimes: string[] = [];
  const tools: string[] = [];
  const packages: Array<{ name: string; version?: string }> = [];
  for (const manifest of manifests) {
    const deps = dependencies(manifest.value);
    if (manifest.name === 'composer.json') {
      languages.push('PHP'); runtimes.push('PHP');
      addDependencyPackages(packages, deps);
      addFrameworks(frameworks, deps, [['laravel/framework', 'Laravel'], ['symfony/framework-bundle', 'Symfony'], ['symfony/symfony', 'Symfony']]);
      if (deps.has('doctrine/dbal')) tools.push('Doctrine DBAL');
    } else if (manifest.name === 'package.json') {
      languages.push('JavaScript'); runtimes.push('Node.js');
      addDependencyPackages(packages, deps);
      addFrameworks(frameworks, deps, [
        ['svelte', 'Svelte'], ['@sveltejs/kit', 'SvelteKit'], ['react', 'React'], ['next', 'Next.js'],
        ['vue', 'Vue'], ['nuxt', 'Nuxt'], ['vite', 'Vite'], ['tailwindcss', 'Tailwind CSS'],
      ]);
      if (deps.has('typescript')) { languages.push('TypeScript'); tools.push('TypeScript'); }
      if (deps.has('vite')) tools.push('Vite');
      if (deps.has('pg')) databases.push('PostgreSQL');
      if (deps.has('mysql2')) databases.push('MySQL');
      if (deps.has('sqlite3') || deps.has('better-sqlite3')) databases.push('SQLite');
    } else if (manifest.name === 'go.mod') {
      languages.push('Go'); runtimes.push('Go');
      const moduleLines = manifest.text.split(/\r?\n/u);
      if (moduleLines.some((line) => /jackc\/pgx|lib\/pq/iu.test(line))) databases.push('PostgreSQL');
    } else if (manifest.name === 'Cargo.toml') {
      languages.push('Rust'); runtimes.push('Rust');
    } else if (manifest.name === 'pyproject.toml') {
      languages.push('Python'); runtimes.push('Python');
      if (/django/iu.test(manifest.text)) frameworks.push({ name: 'Django' });
      if (/postgres|psycopg/iu.test(manifest.text)) databases.push('PostgreSQL');
    }
  }
  const digestInput = manifests.map((manifest) => `${manifest.name}\u0000${manifest.text}`).join('\u0001');
  const manifestDigest = createHash('sha256').update(digestInput, 'utf8').digest('hex');
  const dedupedFrameworks = [...new Map(frameworks.map((item) => [item.name, item])).values()]
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    repositoryId,
    languages: unique(languages),
    frameworks: dedupedFrameworks,
    databases: unique(databases),
    runtimes: unique(runtimes),
    tools: unique(tools),
    packages: [...new Map(packages.map((item) => [item.name, item])).values()].sort((left, right) => left.name.localeCompare(right.name)),
    manifestDigest,
  };
}

export function computeProjectFingerprint(repositoryId: string, repositoryRoot: string): ProjectFingerprint {
  const manifests = ['composer.json', 'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml']
    .map((name) => parseManifest(repositoryRoot, name))
    .filter((manifest): manifest is Manifest => manifest !== undefined);
  return rawFingerprint(repositoryId, manifests);
}

export function projectFingerprint(database: SqliteDatabase, project: ResolvedProjectWorkspace, options: { readOnly?: boolean } = {}): ProjectFingerprint {
  const current = computeProjectFingerprint(project.repositoryId, project.repositoryRoot);
  const cached = database.prepare('SELECT fingerprint_json, manifest_digest FROM repository_fingerprints WHERE repository_id = ?').get<{ fingerprint_json: string; manifest_digest: string }>(project.repositoryId);
  if (cached?.manifest_digest === current.manifestDigest) {
    try {
      const parsed: unknown = JSON.parse(cached.fingerprint_json);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as ProjectFingerprint;
    } catch {
      // Recompute and repair an invalid cache row.
    }
  }
  if (options.readOnly === true) return current;
  database.prepare(`
    INSERT INTO repository_fingerprints (repository_id, fingerprint_json, manifest_digest, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(repository_id) DO UPDATE SET fingerprint_json = excluded.fingerprint_json, manifest_digest = excluded.manifest_digest, updated_at = excluded.updated_at
  `).run(project.repositoryId, JSON.stringify(current), current.manifestDigest, new Date().toISOString());
  return current;
}
