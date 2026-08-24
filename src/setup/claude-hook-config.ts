import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { KiokukoError } from '../errors.js';
import type { DelimitedBlockResult } from './managed-text.js';

const HOOK_EVENT = 'UserPromptSubmit';

export const CLAUDE_PROMPT_HOOK = Object.freeze({
  type: 'mcp_tool',
  server: 'kiokuko',
  tool: 'claude_prompt_context',
  input: {
    prompt: '${prompt}',
    cwd: '${cwd}',
    sessionId: '${session_id}',
  },
  timeout: 5,
  statusMessage: 'Kiokuko: recalling relevant memory',
});

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validation(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Claude settings are not a valid JSON object with valid hook arrays');
}

function validateHookGroups(value: unknown): asserts value is JsonObject[] {
  if (!Array.isArray(value)) validation();
  for (const group of value) {
    if (!isObject(group) || (group.matcher !== undefined && typeof group.matcher !== 'string') || !Array.isArray(group.hooks)) validation();
    for (const handler of group.hooks) {
      if (!isObject(handler)) validation();
    }
  }
}

function validateSettings(value: unknown): asserts value is JsonObject {
  if (!isObject(value)) validation();
  if (value.hooks === undefined) return;
  if (!isObject(value.hooks)) validation();
  for (const groups of Object.values(value.hooks)) validateHookGroups(groups);
}

function isManagedHook(value: JsonObject): boolean {
  return value.type === 'mcp_tool' && value.server === 'kiokuko' && value.tool === 'claude_prompt_context';
}

function formattingOptions(source: string): { insertSpaces: boolean; tabSize: number; eol: '\n' | '\r\n' } {
  const indentation = source.match(/^([ \t]+)(?=["}])/mu)?.[1];
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  if (indentation?.includes('\t')) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indentation?.length || 2, eol };
}

function normalizeUserPromptSubmitGroups(groups: JsonObject[]): JsonObject[] {
  let found = false;
  const normalized = groups.map((group) => {
    const handlers = group.hooks as JsonObject[];
    const nextHandlers: JsonObject[] = [];
    for (const handler of handlers) {
      if (!isManagedHook(handler)) {
        nextHandlers.push(handler);
        continue;
      }
      if (!found) {
        nextHandlers.push({ ...CLAUDE_PROMPT_HOOK, input: { ...CLAUDE_PROMPT_HOOK.input } });
        found = true;
      }
    }
    return { ...group, hooks: nextHandlers };
  });

  if (!found) normalized.push({ hooks: [{ ...CLAUDE_PROMPT_HOOK, input: { ...CLAUDE_PROMPT_HOOK.input } }] });
  return normalized;
}

export function renderClaudePromptHookConfig(existing: string | undefined): DelimitedBlockResult {
  const source = existing === undefined || existing.trim().length === 0 ? '{}\n' : existing;
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: false, disallowComments: true });
  if (errors.length > 0) validation();
  validateSettings(parsed);

  const hooks = parsed.hooks as JsonObject | undefined;
  const groups = hooks?.[HOOK_EVENT];
  const normalizedGroups = normalizeUserPromptSubmitGroups(groups === undefined ? [] : groups as JsonObject[]);
  const edits = modify(source, ['hooks', HOOK_EVENT], normalizedGroups, {
    formattingOptions: formattingOptions(source),
  });
  const content = applyEdits(source, edits);
  return {
    content,
    action: existing === undefined ? 'created' : content === existing ? 'unchanged' : 'updated',
  };
}
