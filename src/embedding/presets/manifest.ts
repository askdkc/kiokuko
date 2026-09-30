import { canonicalContentHash } from '../../serialization/validate.js';

export interface ModelArtifactFile {
  readonly path: string;
  readonly size?: number;
  readonly sha256: string;
}

export interface ModelArtifactPreset {
  readonly id: string;
  readonly schemaVersion: 1;
  readonly artifactRepository: string;
  readonly revision: string;
  readonly transformersJsVersion: string;
  readonly files: readonly ModelArtifactFile[];
  readonly maximumBytes?: number;
  readonly bundledFiles?: readonly { readonly path: string; readonly contents: string }[];
}

export interface LocalEmbeddingPreset extends ModelArtifactPreset {
  readonly id: 'local-small';
  readonly displayName: string;
  readonly sourceModel: 'intfloat/multilingual-e5-small';
  readonly artifactRepository: 'Xenova/multilingual-e5-small';
  readonly dimensions: 384;
  readonly maximumTokens: 512;
  readonly dtype: 'q8';
  readonly pooling: 'mean';
  readonly normalize: true;
  readonly distanceMetric: 'cosine';
  readonly distanceCeiling: number;
  readonly inputContract: 'e5-query-passage-v1';
  readonly queryPrefix: 'query: ';
  readonly documentPrefix: 'passage: ';
  readonly files: readonly LocalEmbeddingPresetFile[];
}

export interface LocalEmbeddingPresetFile extends ModelArtifactFile {
  readonly size: number;
}

export function presetManifestHash(preset: ModelArtifactPreset): string {
  return canonicalContentHash(preset);
}
