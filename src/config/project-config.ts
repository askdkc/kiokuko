import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { KiokukoError } from '../errors.js';

export interface ProjectConfig {
  schemaVersion: 1;
  repositoryId: string;
  workspace: string;
  agentFile: string;
  templateVersion: number;
}

// Binding validation is deliberately strict: unknown fields are rejected rather than ignored.
const REQUIRED_FIELDS = new Set(['schemaVersion', 'repositoryId', 'workspace', 'agentFile', 'templateVersion']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateAgentFile(agentFile: unknown): asserts agentFile is string {
  if (typeof agentFile !== 'string' || agentFile.length === 0 || agentFile.includes('\0')) {
    throw new KiokukoError('VALIDATION_ERROR', 'agentFile must be a non-empty relative path');
  }
  const normalized = agentFile.replaceAll('\\', '/');
  if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').includes('..')) {
    throw new KiokukoError('VALIDATION_ERROR', 'agentFile must remain inside the repository root');
  }
}

export function parseProjectConfig(value: unknown): ProjectConfig {
  if (!isPlainObject(value)) {
    throw new KiokukoError('VALIDATION_ERROR', 'binding must be a JSON object');
  }
  for (const field of Object.keys(value)) {
    if (!REQUIRED_FIELDS.has(field)) {
      throw new KiokukoError('VALIDATION_ERROR', `Unknown binding field: ${field}`);
    }
  }
  if (value.schemaVersion !== 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'Unsupported binding schemaVersion');
  }
  if (typeof value.repositoryId !== 'string' || value.repositoryId.length === 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'repositoryId must be a non-empty string');
  }
  if (typeof value.workspace !== 'string' || value.workspace.length === 0) {
    throw new KiokukoError('VALIDATION_ERROR', 'workspace must be a non-empty string');
  }
  validateAgentFile(value.agentFile);
  const templateVersion = value.templateVersion;
  if (typeof templateVersion !== 'number' || !Number.isInteger(templateVersion) || templateVersion < 1) {
    throw new KiokukoError('VALIDATION_ERROR', 'templateVersion must be a positive integer');
  }
  return {
    schemaVersion: 1,
    repositoryId: value.repositoryId,
    workspace: value.workspace,
    agentFile: value.agentFile,
    templateVersion,
  };
}

export async function readProjectConfig(filePath: string): Promise<ProjectConfig> {
  try {
    return parseProjectConfig(JSON.parse(await readFile(filePath, 'utf8')) as unknown);
  } catch (error) {
    if (error instanceof KiokukoError) throw error;
    throw new KiokukoError('VALIDATION_ERROR', 'Unable to read project binding JSON');
  }
}
