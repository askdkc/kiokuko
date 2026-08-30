import { createHash } from 'node:crypto';
import { canonicalJson } from '../serialization/validate.js';
import { requireEnabledEmbeddingConfig } from './config.js';
import type { EmbeddingConfig, EmbeddingProfile, EmbeddingProfileIdentity, EnabledEmbeddingConfig } from './types.js';

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function endpointFingerprint(endpoint: string): string {
  return sha256(endpoint);
}

export function embeddingProfileId(identity: EmbeddingProfileIdentity): string {
  return sha256(canonicalJson(identity));
}

export function createEmbeddingProfileIdentity(config: EnabledEmbeddingConfig): EmbeddingProfileIdentity {
  return {
    schemaVersion: 1,
    providerKind: config.provider,
    endpointFingerprint: endpointFingerprint(config.baseUrl),
    model: config.model,
    dimensions: config.dimensions,
    distanceMetric: 'cosine',
    documentTemplateVersion: 1,
    queryTemplateVersion: 1,
    distanceCeiling: config.distanceCeiling,
  };
}

export function createEmbeddingProfile(config: EmbeddingConfig): EmbeddingProfile {
  const enabled = requireEnabledEmbeddingConfig(config);
  const identity = createEmbeddingProfileIdentity(enabled);
  return Object.freeze({ profileId: embeddingProfileId(identity), identity: Object.freeze(identity) });
}
