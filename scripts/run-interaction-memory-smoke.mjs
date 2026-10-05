// Live Codex test: fresh sessions, natural user messages, real stdio MCP, isolated DB.
// Uses the CLI's existing login; does not read credentials or rewrite client config.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLiveSession } from './lib/interaction-live-session.mjs';
import { runCorrectionScenarios } from './lib/interaction-correction-scenarios.mjs';
import { openConnection } from '../dist/db/connection.js';
import { getGlobalDatabasePath } from '../dist/config/paths.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await mkdtemp(path.join(tmpdir(), 'kiokuko-live-interaction-'));
const data = path.join(output, 'data');
console.log(`Evidence directory: ${output}`);
const executable = process.env.KIOKUKO_SMOKE_CODEX ?? 'codex';
const scenario = process.env.KIOKUKO_SMOKE_SCENARIO ?? 'all';
assert.ok(['all', 'global', 'project', 'correction'].includes(scenario), 'KIOKUKO_SMOKE_SCENARIO must be all, global, project, or correction');
const prompts = [
  'For Japanese grammar explanations, I prefer two examples about trains before grammatical terminology.',
  'Explain the difference between は and が in Japanese grammar.',
];

async function runSession(index, options = {}) {
  return runLiveSession({ root, output, data, executable, index, prompt: prompts[index], ...options });
}

async function runGlobalScenario() {
  const first = await runSession(0);
  assert.ok(first.calls.some((call) => call.tool === 'memory_capture' && call.status === 'completed'), 'Model did not capture the preference');
  const second = await runSession(1);
  assert.ok(second.calls.some((call) => call.tool === 'memory_recall' && call.status === 'completed'
    && /train/i.test(JSON.stringify(call.result))), 'Second session did not recall the saved preference');
  assert.match(second.answer, /train|電車|列車|汽車/iu, 'Second answer did not use the recalled train preference');
  const database = openConnection(getGlobalDatabasePath({ env: { KIOKUKO_DATA_DIR: data } }), { readOnly: true });
  try {
    for (const table of ['repository_locations', 'ledger_runs', 'akinator_sessions']) {
      assert.equal(database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, `${table} must stay empty`);
    }
  } finally { database.close(); }
  return { naturalPrompts: prompts, captureObserved: true, recallObserved: true, trainPreferenceInLaterAnswer: true };
}

async function runProjectScenario() {
  const project = path.join(output, 'project');
  const unrelated = path.join(output, 'unrelated');
  await mkdir(project);
  await mkdir(unrelated);
  execFileSync('git', ['init', '-q', project]);
  execFileSync('git', ['init', '-q', unrelated]);
  const readme = path.join(project, 'README.md');
  const lsp = 'npx --yes @example/lsp-server';
  await writeFile(readme, '# Setup\n\n## DSH plugin\n\nnpx --yes dsh plugin add github:example/dsh-addon@1.2.3\n\n## LSP startup\n\n' + lsp + '\n');
  const first = await runSession(2, {
    cwd: project, project: true, name: 'project-correction',
    prompt: 'README の DSH プラグイン導入手順を修正してください。標準の dsh plugin コマンドを使い、指定していないバージョン制約を外してください。LSP サーバーの起動例はそのまま残してください。',
  });
  const firstReadme = await readFile(readme, 'utf8');
  assert.match(firstReadme, /dsh plugin .*add github:example\/dsh-addon/u, 'First README edit did not use dsh plugin');
  assert.doesNotMatch(firstReadme, /npx[^\n]*dsh plugin|github:example\/dsh-addon@/u, 'First README retained the rejected form');
  assert.ok(firstReadme.includes(lsp), 'First README lost the LSP startup command');
  const capture = first.calls.find((call) => call.tool === 'memory_capture' && call.status === 'completed'
    && /user_correction/u.test(JSON.stringify(call.arguments)));
  assert.ok(capture, 'Model did not capture the explicit correction as user_correction');
  assert.doesNotMatch(JSON.stringify(capture.arguments), /"replaces"/u, 'First correction invented a replacement ID');
  assert.match(JSON.stringify(capture.result), /"outcome"[^}]*"created"/u, 'Capture response did not confirm creation');

  const databasePath = getGlobalDatabasePath({ env: { KIOKUKO_DATA_DIR: data } });
  const database = openConnection(databasePath, { readOnly: true });
  let saved;
  try {
    const rows = database.prepare('SELECT e.id, e.workspace, r.provenance_json FROM entries e JOIN entry_revisions r ON r.entry_id = e.id AND r.revision = e.current_revision WHERE e.workspace <> ?')
      .all('global');
    const corrections = rows.filter((row) => JSON.parse(row.provenance_json).reference === 'user_correction');
    assert.equal(corrections.length, 1, 'Exactly one project correction must be stored');
    saved = corrections[0];
  } finally { database.close(); }

  await writeFile(readme, '# Plugin installation\n\nInstall the DSH plugin with:\n\nnpx --yes dsh plugin add github:example/dsh-addon@2.0.0\n\nStart the LSP server with:\n\n' + lsp + '\n');
  const second = await runSession(3, {
    cwd: project, project: true, name: 'project-reuse',
    prompt: 'README の DSH プラグイン導入手順を整えてください。LSP サーバーの起動例も残してください。',
  });
  const prepared = second.calls.find((call) => call.tool === 'task_prepare' && call.status === 'completed'
    && JSON.stringify(call.result).includes(saved.id));
  assert.ok(prepared, 'Second session did not receive the saved project correction');
  assert.ok(second.calls.some((call) => call.tool === 'task_memory_review' && call.status === 'completed'
    && JSON.stringify(call.arguments).includes(saved.id) && /adopted/u.test(JSON.stringify(call.arguments))),
  'Second session did not record adoption of the delivered correction');
  const secondReadme = await readFile(readme, 'utf8');
  assert.match(secondReadme, /dsh plugin .*add github:example\/dsh-addon/u, 'Second README did not apply the correction');
  assert.doesNotMatch(secondReadme, /npx[^\n]*dsh plugin|github:example\/dsh-addon@/u, 'Second README retained the rejected form');
  assert.ok(secondReadme.includes(lsp), 'Second README changed the separate LSP startup command');

  const otherReadme = path.join(unrelated, 'README.md');
  await writeFile(otherReadme, '# LSP startup\n\n' + lsp + '\n');
  const third = await runSession(4, {
    cwd: unrelated, project: true, name: 'unrelated-project',
    prompt: 'README の LSP サーバー起動手順の見出しと説明を読みやすくしてください。起動コマンドは維持してください。',
  });
  assert.ok(third.calls.some((call) => call.tool === 'task_prepare' && call.status === 'completed'),
    'Unrelated project did not prepare a task');
  assert.ok(!third.calls.some((call) => call.tool === 'task_prepare' && JSON.stringify(call.result).includes(saved.id)),
    'Project correction leaked to an unrelated repository');
  const thirdReadme = await readFile(otherReadme, 'utf8');
  assert.ok(thirdReadme.includes(lsp), 'Unrelated LSP command changed');
  assert.doesNotMatch(thirdReadme, /dsh plugin/u, 'Unrelated README gained DSH plugin advice');
  return { correctionStored: true, nextSessionDelivered: true, adoptionRecorded: true,
    readmeUpdatedTwice: true, unrelatedProjectExcluded: true, lspNpxPreserved: true };
}

try {
  if (scenario === 'correction') {
    await runCorrectionScenarios({ root, output, executable });
  } else {
    const summary = { client: 'codex', result: 'passed', scenario,
      ...(scenario === 'project' ? {} : { global: await runGlobalScenario() }),
      ...(scenario === 'global' ? {} : { project: await runProjectScenario() }),
      note: 'Disposable repositories and DB; inspect the saved JSONL, capture receipt, review call, and README files for exact behavior. Installed client configuration and desktop runtime were not changed.' };
    await writeFile(path.join(output, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(JSON.stringify(summary));
  }
} catch (error) {
  await writeFile(path.join(output, 'failure.json'), JSON.stringify({ result: error.blocked ? 'blocked' : 'failed', error: error.message }, null, 2));
  console.error(error.message);
  process.exitCode = 1;
}
