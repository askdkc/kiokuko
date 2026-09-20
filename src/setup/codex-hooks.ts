import { KiokukoError } from '../errors.js';
import { parseStrictJson } from './strict-json.js';
export const CODEX_ASSURANCE_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Interrupt', 'SubagentStart', 'SubagentStop'] as const;
const owner = 'Kiokuko memory assurance v1';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new KiokukoError('VALIDATION_ERROR', 'Codex hook configuration is invalid');
  return value as Record<string, unknown>;
}
function owned(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v.type === 'command' && v.statusMessage === owner && typeof v.command === 'string' && v.command.includes(' codex-hook --database ');
}
function configuration(source: string): Record<string, unknown> {
  const value = source.trim() ? object(parseStrictJson(source, { allowTrailingComma: false, disallowComments: true }, 'Codex hooks JSON is invalid')) : {};
  if (value.hooks === undefined) value.hooks = {};
  object(value.hooks);
  return value;
}
export function removeCodexAssuranceHooks(source: string): string | undefined {
  const config = configuration(source);
  const hooks = object(config.hooks);
  let changed = false;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) throw new KiokukoError('VALIDATION_ERROR', 'Codex hook groups must be arrays');
    hooks[event] = (hooks[event] as unknown[]).flatMap(raw => {
      const group = object(raw);
      if (!Array.isArray(group.hooks)) return [group];
      const kept = group.hooks.filter(h => !owned(h));
      if (kept.length === group.hooks.length) return [group];
      changed = true;
      return kept.length ? [{ ...group, hooks: kept }] : [];
    });
    if (!(hooks[event] as unknown[]).length) delete hooks[event];
  }
  if (!changed) return source;
  if (!Object.keys(hooks).length) delete config.hooks;
  return Object.keys(config).length ? JSON.stringify(config, null, 2) + '\n' : undefined;
}
function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
export function renderCodexAssuranceHooks(source: string, executable: string, database: string): string {
  const config = configuration(removeCodexAssuranceHooks(source) ?? '');
  const hooks = object(config.hooks);
  const command = `${shellQuote(executable)} codex-hook --database ${shellQuote(database)}`;
  for (const event of CODEX_ASSURANCE_EVENTS) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new KiokukoError('VALIDATION_ERROR', 'Codex hook groups must be arrays');
    hooks[event] = [...groups, { hooks: [{ type: 'command', command, statusMessage: owner, timeout: 30 }] }];
  }
  return JSON.stringify(config, null, 2) + '\n';
}
export function codexAssuranceConfigured(source: string): boolean {
  const hooks = object(configuration(source).hooks);
  return CODEX_ASSURANCE_EVENTS.every(event => Array.isArray(hooks[event]) && (hooks[event] as unknown[]).some(raw => {
    const group = object(raw);
    return Array.isArray(group.hooks) && group.hooks.some(owned);
  }));
}
