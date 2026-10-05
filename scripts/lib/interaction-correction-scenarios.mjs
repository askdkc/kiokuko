import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { openConnection } from '../../dist/db/connection.js';
import { getGlobalDatabasePath } from '../../dist/config/paths.js';
import { runLiveSession, toolData } from './interaction-live-session.mjs';

const A = '日本語文法の説明では、電車の例を2つ先に示し、その後に用語を説明してほしい。Kiokukoに記憶して。';
const B = 'Kiokukoに記憶した日本語文法の説明の好みを訂正して。今後は用語の説明を先にし、その後に料理の例を1つだけ示して。';
const C = '同じ日本語文法の説明の好みをもう一度訂正して。今後は買い物の例を2つ先に、その後に用語を説明して。Kiokukoに記憶して。';
const query = 'Kiokukoの私の好みを踏まえて、はとがの違いを説明して。';

function captures(session) {
  return session.calls.filter((call) => call.tool === 'memory_capture' && call.status === 'completed'
    && !call.result?.isError && toolData(call)?.enabled === true);
}
function saved(session, outcome) {
  const candidates = captures(session).flatMap((call) => (toolData(call).items ?? []).map((item, index) => ({
    call, item, memory: call.arguments.memories[index],
  }))).filter(({ item }) => item.outcome === outcome && item.availability === 'current');
  assert.equal(candidates.length, 1, `${session.name}: expected one current ${outcome} receipt`);
  assert.equal(candidates[0].item.workspace, 'global', 'Ordinary conversation must remain in Global');
  return candidates[0];
}
function assertReplacement(session, old) {
  const next = saved(session, 'corrected');
  assert.equal(next.memory.basis, 'user_correction');
  assert.deepEqual(next.memory.replaces, { entryId: old.item.entryId, expectedRevision: old.item.revision });
  const index = session.calls.indexOf(next.call);
  assert.ok(session.calls.slice(0, index).some((call) => call.tool === 'memory_recall'
    && toolData(call)?.items?.some((item) => item.entryId === old.item.entryId && item.revision === old.item.revision)),
  'Replacement identity must come from actual recall in this fresh session');
  return next;
}
function assertRecall(session, current, excluded = []) {
  const items = session.calls.filter((call) => call.tool === 'memory_recall').flatMap((call) => toolData(call)?.items ?? []);
  assert.ok(items.some((item) => item.entryId === current.item.entryId), `${session.name}: missing current memory`);
  assert.ok(items.every((item) => !excluded.includes(item.entryId)), `${session.name}: recalled a superseded entry`);
}
function snapshot(data) {
  const db = openConnection(getGlobalDatabasePath({ env: { KIOKUKO_DATA_DIR: data } }), { readOnly: true });
  try {
    return db.prepare(`SELECT e.id, e.workspace, e.status, e.trust_level, e.superseded_by, e.current_revision,
      r.body, r.provenance_json FROM entries e JOIN entry_revisions r ON r.entry_id=e.id AND r.revision=e.current_revision ORDER BY e.id`).all();
  } finally { db.close(); }
}
function assertChain(data, chain) {
  const rows = snapshot(data);
  for (const [index, receipt] of chain.entries()) {
    const row = rows.find((entry) => entry.id === receipt.item.entryId);
    assert.ok(row);
    assert.equal(row.workspace, 'global');
    assert.equal(row.trust_level, 'untrusted');
    assert.equal(JSON.parse(row.provenance_json).type, 'interaction_capture');
    assert.equal(row.status, index === chain.length - 1 ? 'candidate' : 'superseded');
    if (index < chain.length - 1) assert.equal(row.superseded_by, chain[index + 1].item.entryId);
  }
  return rows;
}

/** The evaluator, not the model, sees receipts, DB state, expected answers and previous sessions. */
export async function runCorrectionScenarios({ root, output, executable }) {
  const client = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const patchHash = createHash('sha256').update(execFileSync('git', ['diff', '--binary', 'HEAD', '--', 'src', 'scripts', 'tests', '.github'], { cwd: root })).digest('hex');
  const untracked = {};
  const newFiles = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', '--', 'src', 'scripts', 'tests'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const file of newFiles) untracked[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
  const skills = {};
  for (const name of ['kiokuko-soul', 'memory-reasoning']) {
    skills[name] = createHash('sha256').update(await readFile(path.join(root, 'skills', name, 'SKILL.md'))).digest('hex');
  }
  const summary = { client, executable, sha, patchHash, untracked, skills,
    runtime: { node: process.version, platform: process.platform, arch: process.arch,
      git: execFileSync('git', ['--version'], { encoding: 'utf8' }).trim() },
    embedding: 'off', reranker: 'off',
    model: process.env.KIOKUKO_SMOKE_MODEL ?? 'client default (not exposed)',
    reasoningEffort: process.env.KIOKUKO_SMOKE_REASONING_EFFORT ?? 'client default (not exposed)',
    result: 'not_run', trials: [], answerReviews: [], limitations: ['Actual ChatGPT app and semantic inference are outside this run.'] };
  const persist = () => writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  const review = (session, rubric) => summary.answerReviews.push({ session: session.name,
    file: path.relative(output, session.answerPath), rubric, result: 'not_run', reviewer: null });
  const trials = [];
  for (const length of [2, 3]) for (let attempt = 0; attempt < 3; attempt++) {
    trials.push({ name: `${length === 2 ? 'AB' : 'ABC'}-${attempt + 1}`, run: async (session, data) => {
      const paraphrase = attempt === 2;
      const a = saved(await session('save-A', paraphrase ? '日本語文法を教えるときは、まず鉄道の例文を二つ、あとから専門用語の意味を説明してください。この好みをKiokukoに保存して。' : A), 'created');
      const b = assertReplacement(await session('correct-B', paraphrase ? '保存した日本語文法の教え方を変更します。最初に文法用語を解説し、それから調理についての例文を一つだけ出す形に直して、Kiokukoに保存してください。' : B), a);
      const chain = [a, b];
      if (length === 3) chain.push(assertReplacement(await session('correct-C', paraphrase ? '日本語文法の説明順を再変更します。買い物の例文を二つ提示してから用語を解説する好みに、Kiokukoの記憶を更新してください。' : C), b));
      const answer = await session('apply', query);
      assertRecall(answer, chain.at(-1), chain.slice(0, -1).map(({ item }) => item.entryId));
      assertChain(data, chain);
      review(answer, length === 2 ? '用語の説明→料理の例1つ。電車の例2つを持ち越さず、は/がを正しく説明。' : '買い物の例2つ→用語の説明。電車・料理の旧条件を持ち越さず、は/がを正しく説明。');
    } });
  }
  trials.push({ name: 'first-correction', run: async (session) => {
    const first = await session('correct', 'さっきの説明への訂正です。日本語文法は料理の例を1つ先に示す方針をKiokukoに覚えて。');
    const record = saved(first, 'created');
    assert.equal(record.memory.basis, 'user_correction'); assert.equal(record.memory.replaces, undefined);
    const answer = await session('apply', query); assertRecall(answer, record);
    review(answer, '料理の例1つを先に示し、その後に文法を説明。');
  } });
  trials.push({ name: 'ambiguous', run: async (session, data) => {
    await session('seed', '日本語文法は電車の例を2つ先に、英語文法は旅行の例を1つ先に示す好みを、別々の記憶としてKiokukoに保存してください。');
    const before = snapshot(data);
    assert.equal(before.length, 2);
    const ambiguous = await session('ask', '例より用語を先にするよう、覚えている好みを直して');
    assert.equal(captures(ambiguous).length, 0, 'Must ask before choosing either target');
    assert.deepEqual(snapshot(data), before);
    review(ambiguous, '日本語文法か英語文法かを確認し、保存成功と断言していない。');
    // Explicitly restate the clarification in a fresh session: no hidden transcript or ID is injected.
    const clarified = await session('clarify', '覚えている説明の好みについて、用語を先にするのは日本語文法だけです。電車の例2つはその後に示すようKiokukoの記憶を訂正して。英語文法の好みは変更しないで。');
    const next = saved(clarified, 'corrected');
    const oldId = next.memory.replaces.entryId;
    const old = before.find((row) => row.id === oldId);
    assert.match(old.body, /日本語|Japanese/iu);
    const unchanged = before.find((row) => row.id !== oldId);
    assert.deepEqual(snapshot(data).find((row) => row.id === unchanged.id), unchanged);
    const answer = await session('apply', query); assertRecall(answer, next, [oldId]);
    review(answer, '日本語の用語説明→電車の例2つ。英語の旅行例の条件を混入しない。');
  } });
  trials.push({ name: 'conditional', run: async (session, data) => {
    await session('seed', '日本語文法について、初学者向けなら料理の例を1つ先に、専門家向けなら用語を先に説明する好みを、条件を保持した別々の記憶としてKiokukoに保存してください。');
    const rows = snapshot(data); assert.equal(rows.length, 2); assert.ok(rows.every((row) => row.status === 'candidate'));
    for (const audience of ['初学者', '専門家']) {
      const answer = await session(audience === '初学者' ? 'beginner' : 'expert', `Kiokukoの私の好みを踏まえて、${audience}向けにはとがの違いを説明して。`);
      assert.ok(answer.calls.some((call) => call.tool === 'memory_recall' && toolData(call)?.items?.length));
      review(answer, audience === '初学者' ? '料理の例1つを先に示す。専門家向けの順序を混同しない。' : '用語を先に説明する。初学者向けの順序を混同しない。');
    }
  } });
  trials.push({ name: 'capture-off', run: async (session, data) => {
    const a = saved(await session('seed', A), 'created');
    const before = snapshot(data);
    const answer = await session('disabled', '日本語文法の説明の好みを訂正します。今後は用語の説明を先にし、その後に料理の例を1つだけ示して。その方針ではとがの違いを説明して。', { captureOff: true });
    assert.equal(captures(answer).length, 0); assert.deepEqual(snapshot(data), before);
    review(answer, '現在の回答は用語→料理の例1つ。永続化したと主張せず保存無効を伝える。');
    const later = await session('apply', query); assertRecall(later, a);
    review(later, '保存されている元の好み（電車の例2つ→用語）に従う。');
  } });
  trials.push({ name: 'conflict', run: async (session, data, directory) => {
    const a = saved(await session('seed', A), 'created');
    const correction = await session('race', B, { fault: 'conflict' });
    const events = (await readFile(path.join(directory, 'conflict-race.protocol.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some((event) => event.event === 'concurrent-write'));
    assert.ok(events.some((event) => event.direction === 'response' && event.message.result?.isError));
    const next = assertReplacement(correction, { item: { ...a.item, revision: a.item.revision + 1 } });
    const answer = await session('apply', query); assertRecall(answer, next, [a.item.entryId]);
    assertChain(data, [a, next]);
    review(answer, '用語→料理の例1つ。競合writerが追加した「簡潔に説明」も保持。');
  } });
  trials.push({ name: 'response-loss', run: async (session, data, directory) => {
    const result = await session('save', A + '通信の問題で保存結果が不明になった場合だけ、同じ保存操作を一度だけ再試行してください。二重には保存しないでください。', { fault: 'response-loss' });
    const events = (await readFile(path.join(directory, 'response-loss-save.protocol.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(events.some((event) => event.event === 'response-dropped'));
    const writes = events.filter((event) => event.direction === 'request' && event.message.params.name === 'memory_capture');
    assert.ok(writes.length >= 2, 'The model must perform an actual retry after response loss');
    assert.ok(result.calls.filter((call) => call.tool === 'memory_capture').length >= 2,
      'A transparent client retry alone does not prove a second model tool invocation');
    assert.deepEqual(writes[0].message.params.arguments, writes[1].message.params.arguments, 'Retry must preserve the exact operation and payload');
    assert.equal(snapshot(data).length, 1);
    const record = saved(result, 'created');
    const answer = await session('apply', query); assertRecall(answer, record);
    review(answer, '電車の例2つ→用語。応答喪失後の永続化は実receiptで確認されている。');
  } });
  trials.push({ name: 'project-isolation', run: async (session, data, directory) => {
    const projects = [path.join(directory, 'project-A'), path.join(directory, 'project-B')];
    for (const cwd of projects) { await mkdir(cwd); execFileSync('git', ['init', '-q', cwd]); await writeFile(path.join(cwd, 'README.md'), '# Usage\n\nUse `npx example-tool@1` to start.\n'); }
    const first = await session('correct', 'READMEの起動例を `example-tool start` に訂正してください。このプロジェクトだけの起動方針としてKiokukoに記憶してください。', { cwd: projects[0], project: true });
    const writes = captures(first).flatMap((call) => toolData(call).items);
    assert.ok(writes.length > 0 && writes.every((item) => item.workspace !== 'global'), 'Project-only correction must not create Global memory');
    const other = await session('other', 'READMEの見出しを読みやすくしてください。起動コマンドは変えないで。', { cwd: projects[1], project: true });
    assert.ok(other.calls.some((call) => call.tool === 'task_prepare' && call.status === 'completed'));
    assert.ok(!other.calls.some((call) => ['task_prepare', 'task_answer'].includes(call.tool)
      && writes.some((item) => JSON.stringify(toolData(call)).includes(item.entryId))));
    assert.match(await readFile(path.join(projects[1], 'README.md'), 'utf8'), /npx example-tool@1/u);
  } });
  summary.trials = trials.map(({ name }) => ({ name, result: 'not_run' }));
  await persist();
  let blocked = false;
  for (const [index, trial] of trials.entries()) {
    if (blocked) break;
    const directory = path.join(output, trial.name); await mkdir(directory);
    const data = path.join(directory, 'data');
    const session = (step, prompt, options = {}) => runLiveSession({ root, output: directory, data, executable,
      name: `${trial.name}-${step}`, prompt, ...options });
    try { await trial.run(session, data, directory); summary.trials[index].result = 'passed'; }
    catch (error) { summary.trials[index].result = error.blocked ? 'blocked' : 'failed'; summary.trials[index].error = error.message; blocked = Boolean(error.blocked); }
    summary.trials[index].directory = directory;
    try { await writeFile(path.join(directory, 'state.json'), JSON.stringify(snapshot(data), null, 2)); }
    catch (error) { summary.trials[index].snapshotError = error.message; }
    await persist();
    console.log(`${trial.name}: ${summary.trials[index].result}`);
  }
  summary.automatedResult = blocked ? 'blocked' : summary.trials.some((trial) => trial.result !== 'passed') ? 'failed' : 'passed';
  summary.result = summary.automatedResult === 'passed' ? 'not_run' : summary.automatedResult;
  summary.answerReviewResult = 'not_run';
  summary.limitations.push('Answer meaning/order/count require the recorded rubric to be read and reviewed; automated success alone is not end-to-end success.');
  await persist();
  if (summary.automatedResult !== 'passed') {
    const error = new Error(`Correction scenarios ${summary.automatedResult}; inspect ${path.join(output, 'summary.json')}`);
    error.blocked = blocked; throw error;
  }
  console.log(`Automated assertions passed; answer review pending in ${path.join(output, 'summary.json')}`);
}
