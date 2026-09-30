import { lstat } from 'node:fs/promises';
import type { PathEnvironment } from '../config/paths.js';
import { getRerankerPresetDirectory } from '../config/paths.js';
import type { ModelDownloader, ModelDownloadProgress } from '../embedding/model-download.js';
import { assertNoUnexpectedModelFiles, verifyModelDirectory } from '../embedding/model-manifest.js';
import { installLocalModel, type InstalledModel } from '../embedding/model-installation.js';
import { KiokukoError } from '../errors.js';
import { LOCAL_RERANKER_PRESET } from './preset.js';

export interface RerankerSetupOptions extends PathEnvironment {
  readonly downloader?: ModelDownloader;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ModelDownloadProgress) => void;
  readonly installer?: (options: { downloader?: ModelDownloader; signal?: AbortSignal; onProgress?: (progress: ModelDownloadProgress) => void; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }) => Promise<InstalledModel>;
}

export interface RerankerStatus {
  readonly state: 'missing' | 'ready' | 'invalid';
  readonly presetId: string;
  readonly revision: string;
  readonly directory: string;
  readonly dtype: 'q8';
  readonly bytes?: number;
  readonly manifestHash?: string;
  readonly reason?: string;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export async function rerankerStatus(options: PathEnvironment = {}): Promise<RerankerStatus> {
  const directory = getRerankerPresetDirectory(LOCAL_RERANKER_PRESET.id, LOCAL_RERANKER_PRESET.revision, options);
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new KiokukoError('SECURITY_REJECTION', 'Reranker installation is not a private directory');
    const manifest = await verifyModelDirectory(directory, LOCAL_RERANKER_PRESET);
    await assertNoUnexpectedModelFiles(directory, LOCAL_RERANKER_PRESET);
    return {
      state: 'ready', presetId: LOCAL_RERANKER_PRESET.id, revision: LOCAL_RERANKER_PRESET.revision,
      directory, dtype: LOCAL_RERANKER_PRESET.dtype, bytes: manifest.totalBytes, manifestHash: manifest.artifactManifestHash,
    };
  } catch (error) {
    if (isMissing(error)) return { state: 'missing', presetId: LOCAL_RERANKER_PRESET.id, revision: LOCAL_RERANKER_PRESET.revision, directory, dtype: LOCAL_RERANKER_PRESET.dtype };
    return {
      state: 'invalid', presetId: LOCAL_RERANKER_PRESET.id, revision: LOCAL_RERANKER_PRESET.revision,
      directory, dtype: LOCAL_RERANKER_PRESET.dtype,
      reason: error instanceof Error ? error.message.slice(0, 500) : 'unknown integrity failure',
    };
  }
}

export async function setupReranker(options: RerankerSetupOptions = {}): Promise<RerankerStatus & { installation: 'installed' | 'reused' }> {
  const installed = await (options.installer ?? (async (installerOptions) => installLocalModel(LOCAL_RERANKER_PRESET, {
    ...installerOptions,
    family: 'rerankers',
  })))({
    ...(options.downloader === undefined ? {} : { downloader: options.downloader }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  });
  const status = await rerankerStatus(options);
  if (status.state !== 'ready' || status.manifestHash !== installed.manifestHash) {
    throw new KiokukoError('INTEGRITY_ERROR', 'Installed reranker failed post-install verification');
  }
  return { ...status, installation: installed.installation };
}
