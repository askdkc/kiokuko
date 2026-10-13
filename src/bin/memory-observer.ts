#!/usr/bin/env node
import path from 'node:path';
import { databaseFileIdentity, openConnection, requireDatabaseFileIdentity } from '../db/connection.js';
import { initializeDatabase } from '../commands/init.js';
import { observeMemory, improveMemory } from '../memory/observations.js';
import { observationSchema } from '../memory/observation-contract.js';
import { readReplayObservation } from '../memory/replay-observations.js';
import { supportsNodeVersion } from '../runtime-version.js';

/** Private data worker: it cannot run arbitrary commands or grant authority. */
async function main() {
  if (!supportsNodeVersion(process.versions.node) || process.argv.length !== 4 || process.argv[2] !== '--database'
    || !path.isAbsolute(process.argv[3]!)) throw new Error('invalid worker launch');
  const databasePath = process.argv[3]!;
  // Existing database only. Never create a global memory database on failure.
  const identity = databaseFileIdentity(databasePath);
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('input bound');
  }
  const input = JSON.parse(raw) as Record<string, unknown>;
  const observation = observationSchema.parse(input.observation);
  await initializeDatabase({ databasePath }, { afterPreflight: () => requireDatabaseFileIdentity(databasePath, identity) });
  const db = openConnection(databasePath, { expectedFileIdentity: identity });
  try {
    const result = await observeMemory(db, observation);
    if (result.recorded && typeof input.traceDirectory === 'string'
      && (observation.kind === 'completion' || observation.kind === 'compaction')) {
      const replay = await readReplayObservation({ cwd: observation.cwd, traceDirectory: input.traceDirectory,
        sessionId: observation.sessionId, kind: observation.kind });
      if (replay.observation) await observeMemory(db, replay.observation);
    }
    if (result.recorded) await improveMemory(db, { cwd: observation.cwd });
    process.stdout.write(JSON.stringify(result) + '\n');
  } finally { db.close(); }
}
const timer = setTimeout(() => { process.exit(0); }, 60_000);timer.unref();
try { await main(); }
catch { process.stdout.write(JSON.stringify({ accepted: false, recorded: false, workMayContinue: true,
  warnings: ['memory_observer_unavailable'] }) + '\n'); }
finally { clearTimeout(timer); }
