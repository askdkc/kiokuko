import type { Command } from 'commander';
import { getGlobalDatabasePath } from '../config/paths.js';
import { openConnection } from '../db/connection.js';
import { initializeDatabase } from './init.js';
import { configureDiagnosticRetention, diagnosticRetentionReport, maintainDiagnosticRetention } from '../ledger/diagnostic-retention.js';
import { KiokukoError } from '../errors.js';

export function registerDiagnosticRetentionCommand(cli: Command): void {
  cli.command('diagnostics-retention').description('Configure and compact expired terminal-run diagnostics; memories and replay receipts remain intact')
    .option('--database <path>').option('--days <number>', 'Opt in to retention in days')
    .option('--disable', 'Disable automatic retention').option('--dry-run', 'Read-only preview; no configuration or maintenance')
    .option('--now <instant>', 'Explicit reference time for an operator preview or controlled maintenance')
    .option('--json').action(async (options: { database?: string; days?: string; disable?: boolean; dryRun?: boolean; now?: string }) => {
      if (options.disable && options.days !== undefined) throw new KiokukoError('USAGE_ERROR', 'Choose days or disable');
      const days = options.disable ? null : options.days === undefined ? undefined : Number(options.days);
      const databasePath = options.database ?? getGlobalDatabasePath();
      if (!options.dryRun) await initializeDatabase({ databasePath });
      const db = openConnection(databasePath, { readOnly: options.dryRun === true });
      try {
        const args = { ...(options.now === undefined ? {} : { now: options.now }), ...(days === undefined ? {} : { days }) };
        if (options.dryRun) process.stdout.write(JSON.stringify(diagnosticRetentionReport(db,args))+'\n');
        else {
          if (days !== undefined) configureDiagnosticRetention(db,days);
          process.stdout.write(JSON.stringify(maintainDiagnosticRetention(db,{...args,force:true}))+'\n');
        }
      } finally { db.close(); }
    });
}
