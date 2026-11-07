import { dispatchHookObservation } from '../memory/hook-observation-dispatch.js';
import { considerPendingCaptureReservations } from '../memory/capture-consideration.js';
import { maintainDiagnosticRetention } from '../ledger/diagnostic-retention.js';
import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { databaseFileIdentity, openConnection, requireDatabaseFileIdentity } from '../db/connection.js';
import { inspectMigrationSnapshot, loadMigrationSnapshot } from '../db/migrate.js';
import { initializeDatabase } from './init.js';
import { codexHookCorrelationId, codexHookFailureCode, handleCodexHook, parseCodexHookInput } from '../assurance/codex-hooks.js';
import { codexHookDiagnostics } from '../assurance/hook-diagnostics.js';
import { KiokukoError } from '../errors.js';
import { MEMORY_RECOMMENDATION_INSTRUCTIONS } from '../memory/recommendation-instructions.js';
import { syncCodexDockProject } from '../agenticreplay/codex-service.js';

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
function spawnConsideration(info: { eventId: string; repositoryRoot: string }, databasePath: string): void {
  // Reservation is durable; a failed spawn leaves it for the next hook event
  // or an explicit "kiokuko codex-hook --consider-candidates" run.
  try {
    const entry = process.argv[1];
    if (!entry) return;
    const child = spawn(process.execPath, [...process.execArgv.filter(argument => !argument.startsWith('--test')), entry,
      'codex-hook', '--consider-candidates', '--database', databasePath, '--root', info.repositoryRoot],
      { detached: true, stdio: 'ignore' });
    child.unref();
  } catch { /* The reservation stays pending; consideration is retried later. */ }
}

export function registerCodexHookCommand(cli: Command): void {
  cli.command('codex-hook').description('Handle a Codex lifecycle event from stdin')
    .requiredOption('--database <path>', 'Database used by the installed Kiokuko integration')
    .option('--codex-dock-record', 'Sync newly added Codex projects with an enabled recorder')
    .option('--codex-config <path>', 'Codex profile configured by setup')
    .option('--diagnose-call <id>', 'Read bounded hook metadata for a call or Codex request ID; no stdin or task data')
    .option('--consider-candidates', 'Host-owned consideration of pending capture reservations for --root; no stdin')
    .option('--root <directory>', 'Repository root used by --consider-candidates', process.cwd())
    .action(async (options: { database: string; diagnoseCall?: string; codexDockRecord?: boolean; codexConfig?: string; considerCandidates?: boolean; root?: string }) => {
      let raw = '';
      let event: unknown;
      let eventName: ReturnType<typeof parseCodexHookInput>['hook_event_name'] | 'unknown' = 'unknown';
      try {
        if (options.diagnoseCall !== undefined) {
          if (!/^(?:[0-9a-f]{16}|codex-[0-9a-f]{64})$/u.test(options.diagnoseCall)) throw new KiokukoError('VALIDATION_ERROR', 'Invalid hook correlation ID');
          const database = openConnection(options.database, { readOnly: true });
          try { process.stdout.write(JSON.stringify(codexHookDiagnostics(database, options.diagnoseCall)) + '\n'); }
          finally { database.close(); }
          return;
        }
        if (options.considerCandidates) {
          const root = realpathSync(options.root ?? process.cwd());
          const database = await openHookDatabase(options.database);
          let receipt;
          try { receipt = await considerPendingCaptureReservations(database, root); }
          finally { database.close(); }
          process.stdout.write(JSON.stringify(receipt) + '\n');
          return;
        }
        for await (const chunk of process.stdin) {
          raw += String(chunk);
          if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('Hook input too large');
        }
        event = JSON.parse(raw);
        const input = parseCodexHookInput(event);
        eventName = input.hook_event_name;
        if (options.codexDockRecord && options.codexConfig && (input.hook_event_name === 'SessionStart' || input.hook_event_name === 'UserPromptSubmit')) {
          try { await syncCodexDockProject(input.cwd, options.codexConfig, options.database); }
          catch { process.stderr.write('Optional Codex project recording registration failed. Existing settings and ordinary work remain available.\n'); }
        }
        if (input.hook_event_name === 'SessionStart' || input.hook_event_name === 'PostCompact') {
          process.stdout.write(JSON.stringify({ hookSpecificOutput: {
            hookEventName: input.hook_event_name, additionalContext: MEMORY_RECOMMENDATION_INSTRUCTIONS,
          } }) + '\n');
          return; // Session reminders need neither a checkout nor an available memory database.
        }
        dispatchHookObservation(input, options.database);
        if (input.hook_event_name === 'PreCompact') {
          process.stdout.write('{}\n');
          return; // New compaction observation never waits for a memory DB.
        }
        const database = await openHookDatabase(options.database);
        let result: object;
        let reservationSpawn: { eventId: string; repositoryRoot: string } | undefined;
        try {
          if (input.hook_event_name === 'UserPromptSubmit') maintainDiagnosticRetention(database);
          result = handleCodexHook(database, input, { onReservationCreated: info => { reservationSpawn = info; } });
        }
        finally { database.close(); }
        // Emit only after cleanup succeeds, so a close failure cannot append a
        // second JSON object to an already-written success response.
        process.stdout.write(JSON.stringify(result) + '\n');
        if ('systemMessage' in result && typeof result.systemMessage === 'string') process.stderr.write(result.systemMessage + '\n');
        if (reservationSpawn) spawnConsideration(reservationSpawn, options.database);
      } catch (error) {
        if (options.diagnoseCall !== undefined) {
          const reason = codexHookFailureCode(error);
          process.stdout.write(JSON.stringify({ isError: true, reason }) + '\n');
          process.stderr.write(`Kiokuko diagnosis failed: ${reason}.\n`);
          process.exitCode = 2;
          return;
        }
        const fields = event && typeof event === 'object' ? event as Record<string, unknown> : {};
        const name = eventName;
        const id = codexHookCorrelationId(fields);
        const stage = name === 'PostToolUse' ? 'post_completion' : name === 'PreToolUse' ? 'pre_admission' : 'event';
        const reason = codexHookFailureCode(error);
        const message = `Optional Kiokuko memory observation unavailable: event=${name} stage=${stage} reason=${reason} id=${id}. Work may continue; no execution or persistence success is inferred.${name === 'PostToolUse' ? ' The tool already executed; do not rerun it automatically. Completion recording and memory verification are unavailable.' : ''}`;
        process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
        process.stderr.write(message + '\n');
      }
    });
}
