import path from 'node:path';

export const SQLITE_VEC_LOADER_ID = 'sqlite-vec' as const;

export interface SqliteVecLoadConnection {
  loadExtension(path: string): void;
}

export interface SqliteVecLoader {
  readonly id: typeof SQLITE_VEC_LOADER_ID;
  load(database: SqliteVecLoadConnection): void;
}

/** Probe the scalar operation used by the search backend, not a release number. */
export function probeSqliteVec(read: (sql: string, ...vectors: Uint8Array[]) => unknown): string | null {
  try {
    const versionRow = read('SELECT vec_version() AS version') as { version?: unknown } | null;
    const version = versionRow?.version;
    if (typeof version !== 'string' || version.length === 0 || version.length > 100 || /[\u0000-\u001f\u007f]/u.test(version)) return null;
    const axis = new Uint8Array(8), other = new Uint8Array(8);
    new DataView(axis.buffer).setFloat32(0, 1, true);
    new DataView(other.buffer).setFloat32(4, 1, true);
    const sql = 'SELECT vec_distance_cosine(?, ?) AS distance';
    const self = read(sql, axis, axis) as { distance?: unknown } | null;
    const orthogonal = read(sql, axis, other) as { distance?: unknown } | null;
    if (typeof self?.distance !== 'number' || typeof orthogonal?.distance !== 'number'
      || !Number.isFinite(self.distance) || !Number.isFinite(orthogonal.distance)
      || Math.abs(self.distance) > 0.0001 || Math.abs(orthogonal.distance - 1) > 0.0001) return null;
    return version;
  } catch { return null; }
}

interface SqliteVecPackage {
  getLoadablePath(): string;
  load(database: SqliteVecLoadConnection): void;
}

const knownLoaders = new WeakSet<object>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isSqliteVecPackage(value: unknown): value is SqliteVecPackage {
  if (!isRecord(value)) return false;
  return typeof value.getLoadablePath === 'function' && typeof value.load === 'function';
}

export function isSqliteVecLoader(value: unknown): value is SqliteVecLoader {
  return typeof value === 'object' && value !== null && knownLoaders.has(value);
}

/** Resolve only the exact, package-owned sqlite-vec loader. */
export async function createSqliteVecLoader(): Promise<SqliteVecLoader | null> {
  let candidate: unknown;
  try {
    // Keep the package name constant so optional dependency resolution cannot
    // become an extension-path configuration surface.
    const packageName: string = 'sqlite-vec';
    candidate = await import(packageName);
  } catch {
    return null;
  }
  if (!isSqliteVecPackage(candidate)) return null;

  try {
    const loadablePath = candidate.getLoadablePath();
    if (!path.isAbsolute(loadablePath) || /[\u0000-\u001f\u007f]/u.test(loadablePath)) return null;
  } catch {
    return null;
  }

  const loader = Object.freeze({
    id: SQLITE_VEC_LOADER_ID,
    load(database: SqliteVecLoadConnection): void {
      candidate.load(database);
    },
  });
  knownLoaders.add(loader);
  return loader;
}
