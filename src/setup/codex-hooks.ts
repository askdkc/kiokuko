import { KiokukoError } from '../errors.js';
import { parseStrictJson } from './strict-json.js';
import { fileURLToPath } from 'node:url';
export const CODEX_ASSURANCE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'Interrupt', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact'] as const;
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
export interface CodexHookRuntime { readonly node: string; readonly script: string; }
/** Pin both interpreters: an absolute shebang script still depends on PATH for node. */
export function defaultCodexHookRuntime(): CodexHookRuntime {
  return { node: process.execPath, script: fileURLToPath(new URL('../../dist/bin/kiokuko.js', import.meta.url)) };
}
export function codexDockRecordingConfigured(source: string, configPath: string): boolean {
  const hooks = object(configuration(source).hooks);
  return Object.values(hooks).some(groups => Array.isArray(groups) && groups.some(raw => {
    const group = object(raw);
    return Array.isArray(group.hooks) && group.hooks.some(h => owned(h)
      && (h as {command: string}).command.endsWith(` --codex-dock-record --codex-config ${shellQuote(configPath)}`));
  }));
}
/** Capture before removing managed hooks: absence is distinct from a new event. */
function managedTimeouts(source: string): Map<string, number | undefined> {
  const hooks = object(configuration(source).hooks);
  const timeouts = new Map<string, number | undefined>();
  for (const event of CODEX_ASSURANCE_EVENTS) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new KiokukoError('VALIDATION_ERROR', 'Codex hook groups must be arrays');
    for (const raw of groups) {
      const group = object(raw);
      if (!Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks.filter(owned)) {
        const timeout: unknown = hook.timeout;
        if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout <= 0)) {
          throw new KiokukoError('VALIDATION_ERROR', `Codex ${event} hook timeout must be a positive integer in seconds`);
        }
        if (timeouts.has(event) && timeouts.get(event) !== timeout) {
          throw new KiokukoError('VALIDATION_ERROR', `Conflicting Codex ${event} hook timeouts`);
        }
        timeouts.set(event, timeout as number | undefined);
      }
    }
  }
  return timeouts;
}
function eventTimeout(event: string, existing: Map<string, number | undefined>): number | undefined {
  if (event === 'Interrupt') return Math.min(existing.get(event) ?? 3, 3);
  return existing.has(event) ? existing.get(event) : 30;
}
export function renderCodexAssuranceHooks(source: string, executable: string, database: string, runtime?: CodexHookRuntime, dockConfigPath?: string): string {
  for (const value of [executable, database, ...(runtime ? [runtime.node, runtime.script] : []), ...(dockConfigPath ? [dockConfigPath] : [])]) {
    if (!value.trim() || value.includes('\0')) throw new KiokukoError('VALIDATION_ERROR', 'Codex hook launch paths must be non-empty and contain no NUL');
  }
  const timeouts = managedTimeouts(source);
  const config = configuration(source);
  const hooks = object(config.hooks);
  const launcher = runtime ? `${shellQuote(runtime.node)} ${shellQuote(runtime.script)}` : shellQuote(executable);
  const command = `${launcher} codex-hook --database ${shellQuote(database)}`
    + (dockConfigPath ? ` --codex-dock-record --codex-config ${shellQuote(dockConfigPath)}` : '');
  for (const event of CODEX_ASSURANCE_EVENTS) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new KiokukoError('VALIDATION_ERROR', 'Codex hook groups must be arrays');
    const timeout = eventTimeout(event, timeouts);
    const replacement = { type: 'command', command, statusMessage: owner, ...(timeout === undefined ? {} : { timeout }) };
    let replaced = false;
    hooks[event] = groups.flatMap(raw => {
      const group = object(raw);
      if (!Array.isArray(group.hooks) || !group.hooks.some(owned)) return [group];
      const updated = group.hooks.flatMap(hook => {
        if (!owned(hook)) return [hook];
        if (replaced) return [];
        replaced = true;
        return [{ ...hook, ...replacement }];
      });
      return updated.length ? [{ ...group, hooks: updated }] : [];
    });
    if (!replaced) (hooks[event] as unknown[]).push({ hooks: [replacement] });
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

/** Require exactly one managed hook per lifecycle event, all using one saved interpreter and CLI. */
export function codexAssuranceRuntimeMatches(source: string, runtime: CodexHookRuntime): boolean {
  const hooks = object(configuration(source).hooks);
  const prefix = `${shellQuote(runtime.node)} ${shellQuote(runtime.script)} codex-hook --database `;
  return CODEX_ASSURANCE_EVENTS.every(event => {
    const groups = hooks[event];
    if (!Array.isArray(groups)) return false;
    const managed = groups.flatMap(raw => {
      const group = object(raw);
      return Array.isArray(group.hooks) ? group.hooks.filter(owned) as Array<{ command: string }> : [];
    });
    return managed.length === 1 && managed[0]!.command.startsWith(prefix);
  });
}
