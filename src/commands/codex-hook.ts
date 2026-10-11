import { maintainDiagnosticRetention } from '../ledger/diagnostic-retention.js';
import type { Command } from 'commander';
import { databaseFileIdentity, openConnection, requireDatabaseFileIdentity } from '../db/connection.js';
import { inspectMigrationSnapshot, loadMigrationSnapshot } from '../db/migrate.js';
import { initializeDatabase } from './init.js';
import { codexHookCorrelationId, codexHookFailureCode, handleCodexHook, parseCodexHookInput } from '../assurance/codex-hooks.js';
import { codexHookDiagnostics } from '../assurance/hook-diagnostics.js';
import { KiokukoError } from '../errors.js';

/** Upgrade only an existing database; current-schema hooks avoid a full integrity scan. */
async function openHookDatabase(databasePath: string) {
  const identity = databaseFileIdentity(databasePath);
  const inspection = openConnection(databasePath, { readOnly: true, expectedFileIdentity: identity });
  let pending: boolean;
  try { pending = inspectMigrationSnapshot(inspection, loadMigrationSnapshot()).pending.length > 0; }
  finally { inspection.close(); }
  if (pending) await initializeDatabase({ databasePath }, {
    afterPreflight: () => requireDatabaseFileIdentity(databasePath, identity),
  });
  return openConnection(databasePath, { expectedFileIdentity: identity });
}
/** A hook process never prints raw input, transcripts, shell output or exception payloads. */
export function registerCodexHookCommand(cli: Command): void {
  cli.command('codex-hook').description('Handle a Codex lifecycle event from stdin')
    .requiredOption('--database <path>', 'Database used by the installed Kiokuko integration')
    .option('--diagnose-call <id>', 'Read bounded hook metadata for a correlation ID; no stdin or task data')
    .action(async (options: { database: string; diagnoseCall?: string }) => {
      let raw = '';
      let event: unknown;
      try {
        if (options.diagnoseCall !== undefined) {
          if (!/^[0-9a-f]{16}$/u.test(options.diagnoseCall)) throw new KiokukoError('VALIDATION_ERROR', 'Invalid hook correlation ID');
          const database = openConnection(options.database, { readOnly: true });
          try { process.stdout.write(JSON.stringify(codexHookDiagnostics(database, options.diagnoseCall)) + '\n'); }
          finally { database.close(); }
          return;
        }
        for await (const chunk of process.stdin) {
          raw += String(chunk);
          if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('Hook input too large');
        }
        event = JSON.parse(raw);
        const input = parseCodexHookInput(event);
        const database = await openHookDatabase(options.database);
        try {
          if (input.hook_event_name === 'UserPromptSubmit') maintainDiagnosticRetention(database);
          const result = handleCodexHook(database, input);
          process.stdout.write(JSON.stringify(result) + '\n');
          // Keep the supported UI warning in JSON and a readable copy in hook diagnostics.
          if ('systemMessage' in result && typeof result.systemMessage === 'string') {
            process.stderr.write(result.systemMessage + '\n');
          }
        }
        finally { database.close(); }
      } catch (error) {
        const fields = event && typeof event === 'object' ? event as Record<string, unknown> : {};
        const name = typeof fields.hook_event_name === 'string' ? fields.hook_event_name : 'unknown';
        const id = codexHookCorrelationId(fields);
        const stage = name === 'PostToolUse' ? 'post_completion' : name === 'PreToolUse' ? 'pre_admission' : 'event';
        const reason = codexHookFailureCode(error);
        if (name === 'Stop' || name === 'SubagentStop' || name === 'Interrupt') {
          process.stdout.write(JSON.stringify({ continue: false, stopReason: 'Kiokuko verification unavailable', systemMessage: `Hook failure (${reason}, ${id}) prevented verification. Do not claim verified completion.` }) + '\n');
          return;
        }
        process.stderr.write(`Kiokuko hook failed: event=${name} stage=${stage} reason=${reason} id=${id}.${name === 'PostToolUse' ? ' Tool already executed; do not rerun automatically.' : ''}\n`);
        process.exitCode = 2;
      }
    });
}
