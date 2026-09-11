import { applyEdits, modify, parse } from 'jsonc-parser';
import { isMap, isNode, parseDocument } from 'yaml';
import { KiokukoError } from '../errors.js';
import { renderClaudeConfig } from '../setup/claude-config.js';
import { HERMES_MANAGED_MARKER } from '../setup/hermes-config.js';
import { setupMcpIdentityConflict } from '../setup/mcp-conflict.js';
import { renderOpenCodeConfig } from '../setup/opencode-config.js';
import { isSkillDiscoveryMode } from '../skills/config.js';
import { assertStrictJsonSyntax } from '../setup/strict-json.js';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonObject(source: string, comments: boolean): Record<string, unknown> {
  const options = { allowTrailingComma: comments, disallowComments: !comments };
  assertStrictJsonSyntax(source, options, 'Invalid client configuration');
  const value: unknown = parse(source, [], options);
  if (!object(value)) throw new KiokukoError('VALIDATION_ERROR', 'Client configuration must be an object');
  return value;
}

function removeJsonPath(source: string, location: (string | number)[]): string {
  return applyEdits(source, modify(source, location, undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' },
  }));
}

/** Validate setup ownership before editing the one MCP entry in a shared JSON file. */
export function removeJsonMcpConfig(source: string, client: 'claude' | 'opencode'): string | undefined {
  const root = jsonObject(source, client === 'opencode');
  const key = client === 'claude' ? 'mcpServers' : 'mcp';
  const servers = root[key];
  if (servers === undefined) return source;
  if (!object(servers)) throw new KiokukoError('VALIDATION_ERROR', 'Invalid MCP server map');
  if (!Object.hasOwn(servers, 'kiokuko')) return source;
  const server = servers.kiokuko;
  const command = object(server)
    ? client === 'claude' ? server.command : Array.isArray(server.command) ? server.command[0] : undefined
    : undefined;
  const invokesMcp = object(server) && (client === 'claude'
    ? server.type === 'stdio' && Array.isArray(server.args) && server.args.length === 1 && server.args[0] === 'mcp'
    : server.type === 'local' && Array.isArray(server.command) && server.command.length === 2 && server.command[1] === 'mcp');
  if (!invokesMcp || typeof command !== 'string' || command.trim().length === 0 || command.includes('\0')) {
    setupMcpIdentityConflict(client, `${client} Kiokuko MCP entry cannot be identified as a setup-installed command`);
  }
  // Keep recognizing setup's entry after users disable it or add environment overrides.
  const content = removeJsonPath(source, Object.keys(servers).length === 1 ? [key] : [key, 'kiokuko']);
  // Delete a file only if it is byte-identical to setup's standalone output.
  const environment = client === 'claude' ? (server as Record<string, unknown>).env : (server as Record<string, unknown>).environment;
  const candidateMode = object(environment) ? environment.KIOKUKO_SKILL_DISCOVERY : undefined;
  const mode = isSkillDiscoveryMode(candidateMode) ? candidateMode : undefined;
  const fresh = client === 'claude'
    ? renderClaudeConfig(undefined, command, mode).content
    : renderOpenCodeConfig(undefined, command, mode).content;
  return source === fresh ? undefined : content;
}

/** Remove the marked Hermes entry and preserve other YAML nodes and comments. */
export function removeHermesMcpConfig(source: string): string | undefined {
  const document = parseDocument(source);
  if (document.errors.length > 0 || !isMap(document.contents)) {
    if (source.trim().length === 0) return source;
    throw new KiokukoError('VALIDATION_ERROR', 'Hermes config is not a valid YAML mapping');
  }
  const servers = document.contents.get('mcp_servers', true);
  if (servers === undefined) return source;
  if (!isMap(servers)) throw new KiokukoError('VALIDATION_ERROR', 'Invalid Hermes MCP server map');
  const server = servers.get('kiokuko', true);
  if (server === undefined) return source;
  if (!isNode(server) || server.commentBefore?.trim() !== HERMES_MANAGED_MARKER) {
    setupMcpIdentityConflict('hermes', 'Hermes Kiokuko entry is not marked as managed');
  }
  servers.delete('kiokuko');
  if (servers.items.length === 0) document.contents.delete('mcp_servers');
  const content = document.toString({ lineWidth: 0 }).replaceAll('\n', source.includes('\r\n') ? '\r\n' : '\n');
  return document.contents.items.length === 0 && !document.commentBefore && !document.comment ? undefined : content;
}

/** Remove the obsolete binding ignore entry; retain every other line verbatim. */
export function removeBindingIgnore(source: string): string | undefined {
  const content = source.replace(/^\/?\.kiokuko\.json(?:\r?\n|$)/gmu, '');
  return content.length === 0 ? undefined : content;
}

function isKiokukoHook(value: Record<string, unknown>, client: 'codex' | 'claude'): boolean {
  if (value.type === 'mcp_tool' && value.server === 'kiokuko' && value.tool === 'claude_prompt_context') return true;
  return value.type === 'command' && typeof value.command === 'string'
    && new RegExp(`^.+ enno hook --client ${client} --input-json -$`, 'u').test(value.command);
}

/** Remove retired setup hook handlers without removing neighbouring handlers. */
export function removeLegacyHooks(source: string, client: 'codex' | 'claude'): string | undefined {
  const root = jsonObject(source, false);
  if (root.hooks === undefined) return source;
  if (!object(root.hooks)) throw new KiokukoError('VALIDATION_ERROR', 'Invalid client hook map');
  let content = source;
  for (const event of ['Stop', 'UserPromptSubmit']) {
    const groups = root.hooks[event];
    if (groups === undefined) continue;
    if (!Array.isArray(groups)) throw new KiokukoError('VALIDATION_ERROR', 'Invalid client hook groups');
    for (let groupIndex = groups.length - 1; groupIndex >= 0; groupIndex--) {
      const group: unknown = groups[groupIndex];
      if (!object(group) || !Array.isArray(group.hooks)) throw new KiokukoError('VALIDATION_ERROR', 'Invalid client hook group');
      const matching = group.hooks.map((handler: unknown, index: number) => object(handler) && isKiokukoHook(handler, client) ? index : -1).filter((index: number) => index >= 0);
      if (matching.length === 0) continue;
      if (matching.length === group.hooks.length && Object.keys(group).every(key => key === 'hooks' || key === 'matcher')) {
        content = removeJsonPath(content, ['hooks', event, groupIndex]);
      } else {
        for (const index of matching.reverse()) content = removeJsonPath(content, ['hooks', event, groupIndex, 'hooks', index]);
      }
    }
    const currentHooks = jsonObject(content, false).hooks as Record<string, unknown>;
    if (Array.isArray(currentHooks[event]) && currentHooks[event].length === 0) content = removeJsonPath(content, ['hooks', event]);
  }
  const remaining = jsonObject(content, false);
  if (object(remaining.hooks) && Object.keys(remaining.hooks).length === 0) content = removeJsonPath(content, ['hooks']);
  return Object.keys(jsonObject(content, false)).length === 0 && content !== source ? undefined : content;
}
