import { accessSync, constants, statSync } from 'node:fs';
import { KiokukoError } from '../errors.js';
import { defaultCodexHookRuntime, type CodexHookRuntime } from './codex-hooks.js';

/** Only a real compiled installation may become a new persistent MCP launcher. */
export function defaultCodexMcpRuntime(): CodexHookRuntime {
  const runtime = defaultCodexHookRuntime();
  return validateCodexMcpRuntime(runtime);
}

export function validateCodexMcpRuntime(runtime: CodexHookRuntime): CodexHookRuntime {
  try {
    for (const file of [runtime.node, runtime.script]) {
      if (!statSync(file).isFile()) throw new Error('Not a regular file');
    }
    accessSync(runtime.node, constants.X_OK);
    accessSync(runtime.script, constants.R_OK);
  } catch {
    throw new KiokukoError('SERVICE_UNAVAILABLE', 'The current Node executable or compiled Kiokuko CLI is unavailable. Build or reinstall Kiokuko before configuring a new Codex MCP launcher.');
  }
  return runtime;
}
