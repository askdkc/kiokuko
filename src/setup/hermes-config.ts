import { parseDocument, isMap, isNode, isPair, isScalar, isSeq, type Pair, type YAMLMap } from 'yaml';
import { KiokukoError } from '../errors.js';
import type { DelimitedBlockResult } from './managed-text.js';

export const HERMES_MANAGED_MARKER = 'Managed by `kiokuko setup`.';

type HermesMap = YAMLMap<unknown, unknown>;

function scalarValue(value: unknown): unknown {
  return isScalar(value) ? value.value : undefined;
}

function findKeyPair(map: HermesMap, key: string): Pair | undefined {
  return map.items.find((item) => isPair(item) && scalarValue(item.key) === key);
}

function hasManagedMarker(pair: Pair): boolean {
  return (isNode(pair.key) && pair.key.commentBefore?.includes(HERMES_MANAGED_MARKER) === true)
    || (isNode(pair.value) && pair.value.commentBefore?.includes(HERMES_MANAGED_MARKER) === true);
}

function hasCanonicalManagedShape(pair: Pair): boolean {
  if (!isMap(pair.value)) return false;
  const fields = pair.value.items.map((item) => isPair(item) ? scalarValue(item.key) : undefined);
  if (fields.length !== 2 || fields[0] === fields[1] || !fields.includes('command') || !fields.includes('args')) return false;
  const commandNode = pair.value.get('command', true);
  const argsNode = pair.value.get('args', true);
  return typeof scalarValue(commandNode) === 'string'
    && isSeq(argsNode)
    && argsNode.items.length === 1
    && scalarValue(argsNode.items[0]) === 'mcp';
}

function currentManagedCommand(pair: Pair): string | undefined {
  if (!hasCanonicalManagedShape(pair)) return undefined;
  const command = scalarValue((pair.value as HermesMap).get('command', true));
  return typeof command === 'string' ? command : undefined;
}

function hasRequestedState(pair: Pair, command: string): boolean {
  return currentManagedCommand(pair) === command;
}

function validation(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Hermes config is not a valid YAML mapping');
}

function conflict(): never {
  throw new KiokukoError('CONFLICT', 'Hermes config already contains a conflicting kiokuko MCP server');
}

function serializeHermesDocument(
  document: ReturnType<typeof parseDocument>,
  source: string,
  existing: string | undefined,
): DelimitedBlockResult {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const serialized = document.toString({ lineWidth: 0 }).replaceAll('\r\n', '\n');
  const content = serialized.replaceAll('\n', eol);
  return {
    content,
    action: existing === undefined ? 'created' : content === existing ? 'unchanged' : 'updated',
  };
}

export function renderHermesConfig(existing: string | undefined, command = 'kiokuko'): DelimitedBlockResult {
  const source = existing ?? '';
  const document = parseDocument(source);
  if (document.errors.length > 0) validation();

  let contents: unknown = document.contents;
  if (contents === null) {
    const created = document.createNode({}) as unknown as HermesMap;
    document.contents = created as never;
    contents = created;
  }
  if (!isMap(contents)) validation();

  let mcpServers: unknown = contents.get('mcp_servers', true);
  if (mcpServers !== undefined && !isMap(mcpServers)) validation();
  if (mcpServers === undefined) {
    const created = document.createNode({}) as unknown as HermesMap;
    contents.set('mcp_servers', created);
    mcpServers = created;
  }

  const serverMap = mcpServers as HermesMap;
  const existingPair = findKeyPair(serverMap, 'kiokuko');
  if (existingPair !== undefined) {
    if (!hasManagedMarker(existingPair) || !hasCanonicalManagedShape(existingPair)) conflict();
    if (hasRequestedState(existingPair, command)) return { content: source, action: 'unchanged' };
    if (!isMap(existingPair.value)) conflict();
    existingPair.value.set('command', command);
    return serializeHermesDocument(document, source, existing);
  }

  const pair = document.createPair('kiokuko', { command, args: ['mcp'] }) as unknown as Pair;
  if (!isNode(pair.value)) validation();
  pair.value.commentBefore = ` ${HERMES_MANAGED_MARKER}`;
  serverMap.add(pair);
  return serializeHermesDocument(document, source, existing);
}
