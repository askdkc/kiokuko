import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { KiokukoError } from '../errors.js';
import { canonicalJson } from '../serialization/validate.js';
import type { ModelArtifactFile, ModelArtifactPreset } from './presets/manifest.js';
import { presetManifestHash } from './presets/manifest.js';

export const MODEL_MANIFEST_FILENAME = 'kiokuko-model-manifest.json';
export const MAX_MODEL_BYTES = 512 * 1024 * 1024;

export interface VerifiedModelManifest {
  readonly schemaVersion: 1;
  readonly presetId: string;
  readonly repositoryId: string;
  readonly revision: string;
  readonly artifactManifestHash: string;
  readonly files: readonly ModelArtifactFile[];
  readonly totalBytes: number;
}

function invalid(message: string): never {
  throw new KiokukoError('VALIDATION_ERROR', message);
}

function hashFile(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function validatePresetManifest(preset: ModelArtifactPreset): void {
  if (typeof preset.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(preset.id)
    || preset.schemaVersion !== 1
    || typeof preset.artifactRepository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/u.test(preset.artifactRepository)
    || !/^[0-9a-f]{40}$/u.test(preset.revision)
    || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(preset.transformersJsVersion)) {
    invalid('Model artifact preset manifest is invalid');
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of preset.files) {
    if (paths.has(file.path) || file.path.length === 0 || file.path.startsWith('/')
      || file.path.split('/').some((part) => part === '' || part === '.' || part === '..')
      || file.size !== undefined && (!Number.isSafeInteger(file.size) || file.size <= 0)
      || !/^[0-9a-f]{64}$/u.test(file.sha256)) invalid('Model artifact file manifest is invalid');
    paths.add(file.path);
    totalBytes += file.size ?? 0;
  }
  const maximumBytes = preset.maximumBytes ?? MAX_MODEL_BYTES;
  const bundledPaths = new Set<string>();
  for (const file of preset.bundledFiles ?? []) {
    if (bundledPaths.has(file.path) || !paths.has(file.path) || typeof file.contents !== 'string') {
      invalid('Bundled model artifact file manifest is invalid');
    }
    bundledPaths.add(file.path);
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 2 * 1024 * 1024 * 1024
    || preset.files.length === 0 || totalBytes > maximumBytes) invalid('Model artifact file size is unsupported');
  if ((preset.bundledFiles ?? []).some((file) => !bundledPaths.has(file.path))) invalid('Bundled model artifact file manifest is invalid');
}

export function createModelManifest(preset: ModelArtifactPreset): VerifiedModelManifest {
  validatePresetManifest(preset);
  const totalBytes = preset.files.reduce((total, file) => total + (file.size ?? 0), 0);
  return Object.freeze({
    schemaVersion: 1,
    presetId: preset.id,
    repositoryId: preset.artifactRepository,
    revision: preset.revision,
    artifactManifestHash: presetManifestHash(preset),
    files: Object.freeze(preset.files.map((file) => Object.freeze({ ...file }))),
    totalBytes,
  });
}

export function serializeModelManifest(manifest: VerifiedModelManifest): string {
  return `${canonicalJson(manifest)}\n`;
}

export async function verifyModelDirectory(
  directory: string,
  preset: ModelArtifactPreset,
): Promise<VerifiedModelManifest> {
  const expected = createModelManifest(preset);
  let totalBytes = 0;
  for (const file of expected.files) {
    const filePath = path.join(directory, file.path);
    const stat = await lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new KiokukoError('SECURITY_REJECTION', `Model artifact is not a regular file: ${file.path}`);
    if (file.size !== undefined && stat.size !== file.size) throw new KiokukoError('INTEGRITY_ERROR', `Model artifact size mismatch: ${file.path}`);
    if (hashFile(await readFile(filePath)) !== file.sha256) throw new KiokukoError('SECURITY_REJECTION', `Model artifact hash mismatch: ${file.path}`);
    totalBytes += stat.size;
  }
  if (totalBytes > (preset.maximumBytes ?? MAX_MODEL_BYTES)) throw new KiokukoError('SECURITY_REJECTION', 'Model installation exceeds its configured size limit');
  return Object.freeze({ ...expected, totalBytes });
}

export async function assertNoUnexpectedModelFiles(
  directory: string,
  preset: ModelArtifactPreset,
): Promise<void> {
  const allowed = new Set([...preset.files.map((file) => file.path), MODEL_MANIFEST_FILENAME]);
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new KiokukoError('SECURITY_REJECTION', `Model directory contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative);
      else if (!allowed.has(relative)) throw new KiokukoError('SECURITY_REJECTION', `Model directory contains an unexpected file: ${relative}`);
    }
  };
  await walk(directory, '');
}
