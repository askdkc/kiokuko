import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { KiokukoError } from '../errors.js';
import { createModelManifest, validatePresetManifest, type VerifiedModelManifest } from './model-manifest.js';
import type { ModelArtifactPreset } from './presets/manifest.js';

export interface ModelDownloadProgress {
  readonly file: string;
  readonly completedBytes: number;
  readonly totalBytes: number;
}

export interface DownloadedModel {
  readonly directory: string;
  readonly manifest: VerifiedModelManifest;
}

export interface ModelDownloader {
  download(
    preset: ModelArtifactPreset,
    stagingDirectory: string,
    options?: { readonly signal?: AbortSignal; readonly onProgress?: (progress: ModelDownloadProgress) => void },
  ): Promise<DownloadedModel>;
}

type HubDownloadFile = (params: {
  repo: { type: 'model'; name: string };
  path: string;
  revision: string;
  xet: boolean;
  fetch?: typeof fetch;
}) => Promise<Blob | null>;

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new KiokukoError('SERVICE_UNAVAILABLE', 'Embedding model download was interrupted');
}

export function createHuggingFaceModelDownloader(options: { readonly downloadFile?: HubDownloadFile } = {}): ModelDownloader {
  return {
    download: async (preset, stagingDirectory, downloadOptions = {}) => {
      validatePresetManifest(preset);
      const downloadFile = options.downloadFile ?? (await import('@huggingface/hub')).downloadFile as HubDownloadFile;
      const manifest = createModelManifest(preset);
      await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
      let completedBytes = 0;
      for (const file of preset.files) {
        aborted(downloadOptions.signal);
        const bundled = preset.bundledFiles?.find((item) => item.path === file.path);
        const bytes = bundled === undefined
          ? await downloadPinnedFile(preset, file.path, downloadFile, downloadOptions.signal)
          : new TextEncoder().encode(bundled.contents);
        aborted(downloadOptions.signal);
        if (file.size !== undefined && bytes.byteLength !== file.size) throw new KiokukoError('INTEGRITY_ERROR', `Downloaded model artifact size mismatch: ${file.path}`);
        if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new KiokukoError('SECURITY_REJECTION', `Pinned model artifact hash mismatch: ${file.path}`);
        completedBytes += bytes.byteLength;
        if (completedBytes > (preset.maximumBytes ?? Number.POSITIVE_INFINITY)) throw new KiokukoError('VALIDATION_ERROR', 'Downloaded model exceeds its configured size limit');
        const target = path.join(stagingDirectory, file.path);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
        downloadOptions.onProgress?.({ file: file.path, completedBytes, totalBytes: manifest.totalBytes });
      }
      return { directory: stagingDirectory, manifest };
    },
  };
}

async function downloadPinnedFile(
  preset: ModelArtifactPreset,
  filePath: string,
  downloadFile: HubDownloadFile,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  aborted(signal);
  const blob = await downloadFile({
    repo: { type: 'model', name: preset.artifactRepository },
    path: filePath,
    revision: preset.revision,
    xet: true,
  });
  if (blob === null) throw new KiokukoError('NOT_FOUND', `Pinned model artifact is unavailable: ${filePath}`);
  return new Uint8Array(await blob.arrayBuffer());
}
