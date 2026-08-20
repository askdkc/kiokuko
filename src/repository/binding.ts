import { KiokukoError } from '../errors.js';
import type { SqliteDatabase } from '../db/adapter.js';

export interface RepositoryRegistration {
  repositoryId: string;
  workspace: string;
  displayName: string;
  canonicalRoot: string;
  remoteFingerprint: string | null;
  bindingSchemaVersion: number;
  agentTemplateVersion: number;
  now?: string;
}

export interface RegistrationResult {
  created: boolean;
  repositoryId: string;
  workspace: string;
  canonicalRoot: string;
}

function conflict(message: string): never {
  throw new KiokukoError('CONFLICT', message);
}

export function registerRepositoryAndLocation(
  database: SqliteDatabase,
  registration: RepositoryRegistration,
): RegistrationResult {
  const now = registration.now ?? new Date().toISOString();
  if (registration.remoteFingerprint !== null && !/^sha256:[a-f0-9]{64}$/.test(registration.remoteFingerprint)) {
    throw new KiokukoError('VALIDATION_ERROR', 'remoteFingerprint must be a SHA-256 fingerprint');
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    const location = database
      .prepare('SELECT repository_id FROM repository_locations WHERE canonical_root = ?')
      .get<{ repository_id: string }>(registration.canonicalRoot);
    if (location && location.repository_id !== registration.repositoryId) {
      conflict('Repository root is already bound to another repository ID; rebind is required');
    }

    const repository = database
      .prepare('SELECT workspace FROM repositories WHERE repository_id = ?')
      .get<{ workspace: string }>(registration.repositoryId);
    if (repository && repository.workspace !== registration.workspace) {
      conflict('Repository ID is already bound to another workspace');
    }

    const workspace = database
      .prepare('SELECT repository_id FROM repositories WHERE workspace = ?')
      .get<{ repository_id: string }>(registration.workspace);
    if (workspace && workspace.repository_id !== registration.repositoryId) {
      conflict('Workspace is already bound to another repository ID');
    }

    const created = !repository;
    if (created) {
      database
        .prepare(`
          INSERT INTO repositories (
            repository_id, workspace, display_name, remote_fingerprint,
            binding_schema_version, agent_template_version, created_at, last_used_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          registration.repositoryId,
          registration.workspace,
          registration.displayName,
          registration.remoteFingerprint,
          registration.bindingSchemaVersion,
          registration.agentTemplateVersion,
          now,
          now,
        );
    } else {
      database
        .prepare('UPDATE repositories SET last_used_at = ?, display_name = ?, agent_template_version = ? WHERE repository_id = ?')
        .run(now, registration.displayName, registration.agentTemplateVersion, registration.repositoryId);
    }

    if (!location) {
      database
        .prepare(`
          INSERT INTO repository_locations (
            repository_id, canonical_root, first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?)
        `)
        .run(registration.repositoryId, registration.canonicalRoot, now, now);
    } else {
      database
        .prepare('UPDATE repository_locations SET last_seen_at = ? WHERE repository_id = ? AND canonical_root = ?')
        .run(now, registration.repositoryId, registration.canonicalRoot);
    }
    database.exec('COMMIT');
    return {
      created,
      repositoryId: registration.repositoryId,
      workspace: registration.workspace,
      canonicalRoot: registration.canonicalRoot,
    };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original conflict or SQLite error.
    }
    throw error;
  }
}
