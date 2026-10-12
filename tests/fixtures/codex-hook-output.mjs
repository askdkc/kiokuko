import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const schemas = Object.fromEntries(['PreToolUse', 'PostToolUse'].map(event => [event,
  JSON.parse(readFileSync(new URL(`./codex-hook-schemas/${event === 'PreToolUse' ? 'pre' : 'post'}-tool-use.command.output.schema.json`, import.meta.url), 'utf8'))]));

// Only the keywords used by these pinned generated schemas. Rejecting unknown
// values/keys is independent of Kiokuko's own response producer.
function validateWire(value, schema, root) {
  if (schema.$ref) {
    const target = schema.$ref.slice(2).split('/').reduce((part, key) => part[key], root);
    validateWire(value, target, root);
  }
  for (const part of schema.allOf ?? []) validateWire(value, part, root);
  if (schema.const !== undefined) assert.equal(value, schema.const);
  if (schema.enum) assert.ok(schema.enum.includes(value));
  if (schema.type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `missing hook field: ${key}`);
    for (const key of Object.keys(value)) {
      if (schema.additionalProperties === false) assert.ok(Object.hasOwn(schema.properties, key), `unsupported hook field: ${key}`);
      if (schema.properties[key]) validateWire(value[key], schema.properties[key], root);
    }
  } else if (schema.type) assert.equal(typeof value, schema.type);
}

// Independent consumer contract for the shapes Kiokuko emits. Release behavior:
// https://learn.chatgpt.com/docs/hooks#pretooluse and #posttooluse (2026-10-12).
// Codex rejects unknown JSON keys; parseable JSON alone is not acceptance.
export function acceptCodexToolHook(stdout, event) {
  const output = JSON.parse(stdout);
  validateWire(output, schemas[event], schemas[event]);
  assert.ok(output && typeof output === 'object' && !Array.isArray(output));
  for (const key of Object.keys(output)) assert.ok(['systemMessage', 'hookSpecificOutput'].includes(key), `unsupported hook field: ${key}`);
  if (output.systemMessage !== undefined) assert.equal(typeof output.systemMessage, 'string');
  const specific = output.hookSpecificOutput;
  if (specific) {
    assert.equal(specific.hookEventName, event);
    const keys = event === 'PreToolUse'
      ? ['hookEventName', 'permissionDecision', 'permissionDecisionReason', 'additionalContext']
      : ['hookEventName', 'additionalContext'];
    for (const key of Object.keys(specific)) assert.ok(keys.includes(key), `unsupported ${event} field: ${key}`);
    for (const key of ['permissionDecisionReason', 'additionalContext']) if (specific[key] !== undefined) assert.equal(typeof specific[key], 'string');
    if (specific.permissionDecision !== undefined) assert.equal(specific.permissionDecision, 'deny');
  }
  return output;
}

// Code mode applies hooks to each nested tool, before execution and after its
// result. An exit-2 Post hook rejects the promise after side effects occurred.
export async function runCodexNestedTool(hook, call, execute) {
  const before = hook({ ...call, hook_event_name: 'PreToolUse' });
  if (before.status === 2) throw new Error(before.stderr);
  assert.equal(before.status, 0, before.stderr);
  const pre = acceptCodexToolHook(before.stdout, 'PreToolUse');
  if (pre.hookSpecificOutput?.permissionDecision === 'deny') throw new Error(pre.hookSpecificOutput.permissionDecisionReason);
  const result = await execute();
  const after = hook({ ...call, hook_event_name: 'PostToolUse', tool_response: result });
  if (after.status === 2) throw new Error(after.stderr);
  assert.equal(after.status, 0, after.stderr);
  acceptCodexToolHook(after.stdout, 'PostToolUse');
  return result;
}
