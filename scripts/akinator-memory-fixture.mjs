import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConnection } from '../dist/db/connection.js';
import { migrateDatabase } from '../dist/db/migrate.js';
import { resolveProjectWorkspace } from '../dist/memory/workspaces.js';
import { AgentGatewayService } from '../dist/gateway/agent-service.js';

export const capabilities = [{ kind: 'skill', name: 'kiokuko-soul' }, { kind: 'skill', name: 'memory-reasoning' }];
export const base = { taskType: 'build', target: null, expected: 'tests pass', constraints: null };
export async function fixture({ reuseSeedStatements = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'kiokuko-akinator-evaluation-'));
  const database = openConnection(':memory:');
  try {
    migrateDatabase(database);
    execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'src/feature.ts'), 'export const value = 1;\n');
    const project = await resolveProjectWorkspace(database, root);
    const scope = { workspace: project.workspace, repositoryId: project.repositoryId, repositoryRoot: project.repositoryRoot };
    // Only synthetic corpus construction reuses SQL statements. Measured calls use the raw adapter.
    const statements = new Map();
    const seedDatabase = reuseSeedStatements ? {
      filePath: database.filePath, exec: sql => database.exec(sql), close: () => database.close(),
      prepare(sql) {
        if (!statements.has(sql)) statements.set(sql, database.prepare(sql));
        return statements.get(sql);
      },
    } : database;
    const service = new AgentGatewayService(seedDatabase);
    let index = 0;
    return {
      database, seedDatabase, root, scope,
      finishSeeding() { statements.clear(); },
      addProfile(target = 'src/feature.ts', status = 'completed', task = target) {
        const run = service.openRun({ idempotencyKey: `profile-${++index}`, request: {
          apiVersion: '1', workspace: scope.workspace, client: { kind: 'test' },
          task: { title: task, query: task, profileHints: { ...base, target } },
          captureProfile: 'minimal', coverage: { run: 'unavailable', tool: 'unavailable', command: 'unavailable', file: 'unavailable', approval: 'unavailable' },
        } });
        service.closeRun({ runId: run.runId, idempotencyKey: 'closed', request: { apiVersion: '1', status } });
        return run;
      },
      async close() { database.close(); await rm(root, { recursive: true, force: true }); },
    };
  } catch (error) { database.close(); await rm(root, { recursive: true, force: true }); throw error; }
}
export function printReport(report) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
