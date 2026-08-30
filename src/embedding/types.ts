import type { SqliteDatabase } from '../db/adapter.js';

export type EmbeddingMode = 'off' | 'optional' | 'required';
export type VectorBackendPreference = 'auto' | 'javascript' | 'sqlite-vec';
export type EmbeddingProviderKind = 'openai-compatible';

export interface EmbeddingConfig {
  readonly mode: EmbeddingMode;
  readonly provider: EmbeddingProviderKind;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly dimensions?: number;
  readonly distanceCeiling?: number;
  readonly apiKey?: string;
  readonly allowRemote: boolean;
  readonly vectorBackend: VectorBackendPreference;
  readonly timeoutMs: number;
  readonly batchSize: number;
}

export interface EnabledEmbeddingConfig extends EmbeddingConfig {
  readonly mode: 'optional' | 'required';
  readonly baseUrl: string;
  readonly model: string;
  readonly dimensions: number;
  readonly distanceCeiling: number;
}

export interface EmbeddingProfileIdentity {
  readonly schemaVersion: 1;
  readonly providerKind: 'openai-compatible';
  readonly endpointFingerprint: string;
  readonly model: string;
  readonly dimensions: number;
  readonly distanceMetric: 'cosine';
  readonly documentTemplateVersion: 1;
  readonly queryTemplateVersion: 1;
  readonly distanceCeiling: number;
}

export interface EmbeddingProfile {
  readonly profileId: string;
  readonly identity: EmbeddingProfileIdentity;
}

export interface PreparedSemanticQuery {
  readonly profileId: string;
  readonly dimensions: number;
  readonly vector: Float32Array;
  readonly vectorHash: string;
  readonly backendId: string;
  readonly distanceCeiling: number;
}

export interface EmbeddingDocument {
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly documentHash: string;
  readonly truncated: boolean;
}

export interface VectorSearchInput {
  readonly profileId: string;
  readonly dimensions: number;
  readonly queryVector: Float32Array;
  readonly distanceCeiling: number;
  readonly workspace?: string;
  readonly excludedWorkspaces?: readonly string[];
  readonly limit: number;
}

export interface VectorHit {
  readonly entryId: string;
  readonly distance: number;
}

export interface VectorSearchBackend {
  readonly id: string;
  search(database: SqliteDatabase, input: VectorSearchInput): VectorHit[];
}

export interface EmbeddingProvider {
  readonly profile: EmbeddingProfileIdentity;

  embed(
    inputs: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<readonly Float32Array[]>;
}

export interface EmbeddingDrainResult {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
  readonly blocked: number;
  readonly remaining: number;
}

export interface EmbeddingRuntime {
  readonly mode: EmbeddingMode;
  readonly profileId: string | null;
  readonly backendId: string | null;
  readonly backend: VectorSearchBackend | null;

  prepareQuery(
    database: SqliteDatabase,
    text: string,
  ): Promise<PreparedSemanticQuery | null>;

  drain(options: {
    workspace?: string;
    maxJobs: number;
    deadlineMs: number;
  }): Promise<EmbeddingDrainResult>;

  close(): Promise<void>;
}
