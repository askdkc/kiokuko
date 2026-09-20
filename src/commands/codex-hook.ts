import type { Command } from 'commander';
import { openConnection } from '../db/connection.js';
import { handleCodexHook } from '../assurance/codex-hooks.js';
/** A hook process never prints raw input, transcripts, shell output or exception payloads. */
export function registerCodexHookCommand(cli: Command): void {
  cli.command('codex-hook').description('Handle a Codex lifecycle event from stdin')
    .requiredOption('--database <path>', 'Database used by the installed Kiokuko integration')
    .action(async (options: { database: string }) => {
      let raw = '';
      let event: unknown;
      try {
        for await (const chunk of process.stdin) {
          raw += String(chunk);
          if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('Hook input too large');
        }
        event = JSON.parse(raw);
        const database = openConnection(options.database);
        try { process.stdout.write(JSON.stringify(handleCodexHook(database, event)) + '\n'); }
        finally { database.close(); }
      } catch {
        const name = event && typeof event === 'object' ? (event as Record<string, unknown>).hook_event_name : undefined;
        if (name === 'Stop' || name === 'SubagentStop' || name === 'Interrupt') {
          process.stdout.write(JSON.stringify({ continue: false, stopReason: 'Kiokuko verification unavailable', systemMessage: 'Hook failure prevented verification. Do not claim verified completion.' }) + '\n');
          return;
        }
        process.stderr.write('Kiokuko hook failed; preparation or verification could not be established.\n');
        process.exitCode = 2;
      }
    });
}
