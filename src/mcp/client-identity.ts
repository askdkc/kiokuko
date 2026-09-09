import { KiokukoError } from '../errors.js';
const CLIENT_KINDS = ['codex', 'claude', 'opencode'] as const;
type ClientKind = (typeof CLIENT_KINDS)[number];

export interface TaskClientHint {
  kind?: string;
  version?: string;
  sessionId?: string;
}

export interface TaskClientHintInput {
  kind?: string | undefined;
  version?: string | undefined;
  sessionId?: string | undefined;
}

export interface McpClientImplementation {
  name: string;
  title?: string | undefined;
  version: string;
}

const CLIENT_ALIASES: Readonly<Record<ClientKind, readonly string[]>> = {
  codex: ['codex', 'codex-mcp-client'],
  claude: ['claude', 'claude-ai', 'claude-code'],
  opencode: ['opencode'],
};

function normalizedClientName(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200
    || value.trim() !== value || /[\p{Cc}\p{Cf}]/u.test(value)) return null;
  return value.normalize('NFKC').toLowerCase();
}

function boundedVersion(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100
    || value.trim() !== value || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  return value;
}

export function identifyClientKind(value: unknown): ClientKind | null {
  const normalized = normalizedClientName(value);
  if (normalized === null) return null;
  return CLIENT_KINDS.find((kind) => CLIENT_ALIASES[kind].includes(normalized)) ?? null;
}

export function identifyMcpClientKind(client: McpClientImplementation | undefined): ClientKind | null {
  if (client === undefined) return null;
  const fromName = identifyClientKind(client.name);
  const fromTitle = identifyClientKind(client.title);
  if (fromName !== null && fromTitle !== null && fromName !== fromTitle) {
    throw new KiokukoError('CONFLICT', 'MCP client identity is contradictory');
  }
  return fromName ?? fromTitle;
}

export function resolveTaskPrepareClient(
  explicit: TaskClientHintInput | undefined,
  runtime: McpClientImplementation | undefined,
): TaskClientHint | undefined {
  const runtimeKind = identifyMcpClientKind(runtime);
  const explicitKind = identifyClientKind(explicit?.kind);
  if (runtimeKind !== null && explicit?.kind !== undefined && explicitKind !== runtimeKind) {
    throw new KiokukoError('CONFLICT', 'Explicit client identity conflicts with the MCP client');
  }
  if (runtimeKind !== null) {
    const runtimeVersion = boundedVersion(runtime?.version);
    return {
      kind: runtimeKind,
      ...(runtimeVersion === undefined ? {} : { version: runtimeVersion }),
      ...(explicit?.sessionId === undefined ? {} : { sessionId: explicit.sessionId }),
    };
  }
  if (explicit !== undefined) {
    return {
      ...(explicit.kind === undefined ? {} : { kind: explicit.kind }),
      ...(explicit.version === undefined ? {} : { version: explicit.version }),
      ...(explicit.sessionId === undefined ? {} : { sessionId: explicit.sessionId }),
    };
  }
  if (runtime === undefined) return undefined;
  const runtimeVersion = boundedVersion(runtime.version);
  return {
    kind: runtime.name,
    ...(runtimeVersion === undefined ? {} : { version: runtimeVersion }),
  };
}
