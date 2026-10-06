import { probeNativeSandbox, sandboxProbeValid } from './lib/normal-workflow/native-sandbox.mjs';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { policyHash, validatePolicy, requiredAttempts } from './lib/normal-workflow/release-policy.mjs';
import { SCENARIOS, approvalErrors, releaseGate } from './lib/normal-workflow/contracts.mjs';
import { createFixture, evaluateAttempt, hash, snapshot, treeHash } from './lib/normal-workflow/oracle.mjs';
import { runCodex, bindExecutorCheckpoints, isolatedMcpPolicy } from './lib/normal-workflow/codex-adapter.mjs';
import { sourceFingerprint } from './lib/normal-workflow/source-state.mjs';
import { captureSanitizer } from './lib/normal-workflow/log-safety.mjs';
import { observeInstructions } from './lib/normal-workflow/instruction-observation.mjs';
import { collectInstructionReceipt } from './lib/normal-workflow/instruction-receipt.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
if (args.includes('--help')) {
  console.log('Usage: node scripts/run-normal-workflow-acceptance.mjs --offline [--output NEW_DIRECTORY]\n  or --approval APPROVAL.json --policy POLICY.json --policy-hash APPROVED_HASH [--output NEW_DIRECTORY]\nResults and a fail-closed release gate are saved; offline never passes G3. See docs/normal-workflow-acceptance.md.');
  process.exit(0);
}
const output = path.resolve(flag('--output') ?? mkdtempSync(path.join(tmpdir(), 'kiokuko-normal-results-')));
if (existsSync(output) && readdirSync(output).length) throw new Error('Acceptance output must be empty: previous attempts cannot be overwritten');
mkdirSync(output, { recursive: true });
let approval;
let approvalError;
if (flag('--approval')) {
  try { approval = JSON.parse(readFileSync(flag('--approval'), 'utf8')); }
  catch { approvalError = 'Approval file cannot be read or parsed'; }
}
const offline = args.includes('--offline') || !approval;
const candidate = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim() !== '',
  sourceDigest: sourceFingerprint(root), artifactHash: null };
const clients = Array.isArray(approval?.clients) && approval.clients.length
  && approval.clients.every(client => ['codex-cli', 'codex-desktop'].includes(client))
  ? [...new Set(approval.clients)] : ['codex-cli', 'codex-desktop'];
const reviews=flag('--reviews') ? JSON.parse(readFileSync(flag('--reviews'),'utf8')) : [];
if(!Array.isArray(reviews) || new Set(reviews.map(x=>x.id)).size !== reviews.length) throw new Error('Invalid reviews');
const reports = [];
let configurationHash = null;
const blocked = (client, scenario, classification, reason) => reports.push({ ...candidate, client, scenario: scenario.id, executionMode: offline ? 'offline' : 'live',
  classification, reason, instructionsVerified: false, oraclePassed: false });

// Codex CLI has no hard dollar-spend controller. Paid API runs are unsupported;
// only explicitly approved included-subscription test credentials may be used.
const authorized = !approvalError && approvalErrors(approval).length === 0;
let policy;
let policyError;
if (authorized && !offline) {
  try {
    policy = validatePolicy(JSON.parse(readFileSync(flag('--policy'),'utf8')), flag('--policy-hash'));
    for (const key of ['provider','model','clientVersion','reasoningEffort','clients','attempts','maxSeconds','maxTotalSeconds','maxTurns','maxToolCalls','maxCost','currency'])
      if (JSON.stringify(approval[key]) !== JSON.stringify(policy[key])) throw new Error('Approval differs from frozen policy');
    configurationHash = policyHash(policy);
    writeFileSync(path.join(output,'policy.json'),JSON.stringify(policy));
  } catch { policyError = 'Independently frozen approval policy/hash missing or mismatched'; }
}

let credentials;
if (authorized && !offline && !policyError) {
  try {
    credentials = JSON.parse(readFileSync(approval.authFile, 'utf8'));
    if (credentials.auth_mode !== 'chatgpt' || credentials.OPENAI_API_KEY || typeof credentials.tokens?.access_token !== 'string') throw new Error('Wrong credential mode');
  } catch { credentials = undefined; }
}

const run = (command, arguments_, cwd, environment) => execFileSync(command, arguments_, {
  cwd, env: environment, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
let controls;
const overallStarted = Date.now();
try {
  if (!offline && authorized && credentials && !policyError) {
    controls = mkdtempSync(path.join(tmpdir(), 'kiokuko-normal-control-'));
    const environment = { PATH: process.env.PATH, HOME: path.join(controls, 'home'), USERPROFILE: path.join(controls, 'home'),
      npm_config_cache: path.join(controls, 'npm-cache'), npm_config_userconfig: path.join(controls, 'npmrc') };
    mkdirSync(environment.HOME); writeFileSync(environment.npm_config_userconfig, '');
    const packDir = path.join(controls, 'pack'); mkdirSync(packDir);
    run('npm', ['run', 'build'], root, environment);
    let tarball;
    if (flag('--candidate')) {
      const prior = JSON.parse(readFileSync(flag('--candidate'), 'utf8'));
      tarball = flag('--artifact');
      if (!tarball || prior.commit !== candidate.commit || prior.dirty !== candidate.dirty || prior.sourceDigest !== candidate.sourceDigest
        || hash(readFileSync(tarball)) !== prior.artifactHash) throw new Error('Candidate artifact mismatch');
    } else {
      const packed = JSON.parse(run('npm', ['pack', '--pack-destination', packDir, '--json'], root, environment));
      tarball = path.join(packDir, packed[0].filename);
    }
    candidate.artifactHash = hash(readFileSync(tarball));
    cpSync(tarball, path.join(output, 'candidate.tgz'));
    const prefix = path.join(controls, 'prefix');
    run('npm', ['install', '--global', '--prefix', prefix, tarball], root, environment);
    const installed = path.join(prefix, 'lib/node_modules/kiokuko');
    const executable = path.join(installed, 'dist/bin/kiokuko.js');
    const { sanitizeJson } = await import(pathToFileURL(path.join(installed, 'dist/security/sanitize.js')).href);
    const sanitize = captureSanitizer(sanitizeJson, credentials);
    const clientExecutable = approval.executable ?? 'codex';
    let version;
    try { version = run(clientExecutable, ['--version'], controls, environment).trim(); }
    catch { for (const client of clients) for (const scenario of SCENARIOS) blocked(client, scenario, 'BLOCKED_ENV', 'Client unavailable'); }
    if (version && version !== `codex-cli ${policy.clientVersion}`) {
      for (const client of clients) for (const scenario of SCENARIOS) blocked(client, scenario, 'BLOCKED_ENV', 'Client version differs from approval');
      version = undefined;
    }
    if (version) for (const client of clients) for (const scenario of SCENARIOS) {
      if (sourceFingerprint(root) !== candidate.sourceDigest) { blocked(client, scenario, 'NOT_RUN', 'Candidate source changed'); continue; }
      if (Date.now() - overallStarted >= approval.maxTotalSeconds * 1000) { blocked(client, scenario, 'NOT_RUN', 'Approved total time limit reached'); continue; }
      if (client !== 'codex-cli') { blocked(client, scenario, 'NOT_RUN', 'No desktop event and instruction-load adapter; CLI is not a substitute'); continue; }
      const base = path.join(controls, scenario.id); mkdirSync(base);
      const scenarioOutput = path.join(output, scenario.id); mkdirSync(path.join(scenarioOutput, 'snapshots'), { recursive: true });
      const repo = path.join(base, 'repo'); createFixture(repo, scenario.kind);
      if (scenario.kind !== 'conversation') run('git', ['init', '-q'], repo, environment);
      const env = { ...environment, HOME: path.join(base, 'home'), USERPROFILE: path.join(base, 'home'),
        CODEX_HOME: path.join(base, 'codex'), KIOKUKO_DATA_DIR: path.join(base, 'data'),
        KIOKUKO_SKILL_DISCOVERY: 'off', KIOKUKO_EMBEDDINGS: 'off', KIOKUKO_HANDOFF: 'off' };
      mkdirSync(env.HOME); mkdirSync(env.CODEX_HOME);
      // Test credentials are never copied into saved evidence or the agent workspace.
      cpSync(approval.authFile, path.join(env.CODEX_HOME, 'auth.json'));
      run(process.execPath, [executable, 'setup', '--clients', 'codex', '--command', executable, '--no-embeddings', '--json'], repo, env);
      const { logicalSkillName } = await import(pathToFileURL(path.join(installed,'dist/setup/standard-skills.js')).href);
      const installedVersion = JSON.parse(readFileSync(path.join(installed,'package.json'),'utf8')).version;
      const indexes = readdirSync(path.join(env.HOME, '.agents/skills')).map(name => ({ name,
        text: readFileSync(path.join(env.HOME, '.agents/skills', name, 'SKILL.md'), 'utf8'), canonicalName:logicalSkillName(name),
        bundleText:readFileSync(path.join(installed,'skills',logicalSkillName(name),'SKILL.md'),'utf8'),packageVersion:installedVersion }));
      const globalAgents = readFileSync(path.join(env.CODEX_HOME, 'AGENTS.md'), 'utf8');
      const hooks = JSON.parse(readFileSync(path.join(env.CODEX_HOME, 'hooks.json'), 'utf8'));
      const instructions = { agents: globalAgents, indexes, hooks };
      const controlsHash = hash(JSON.stringify(instructions));
      writeFileSync(path.join(scenarioOutput, 'instructions.json'), JSON.stringify(instructions, null, 2));
      const initial = snapshot(repo); writeFileSync(path.join(scenarioOutput, 'initial.json'), JSON.stringify(initial));
      const { getGlobalDatabasePath } = await import(pathToFileURL(path.join(installed, 'dist/config/paths.js')).href);
      const { openConnection } = await import(pathToFileURL(path.join(installed, 'dist/db/connection.js')).href);
      const { initializeDatabase } = await import(pathToFileURL(path.join(installed, 'dist/commands/init.js')).href);
      const databasePath = getGlobalDatabasePath({ env }); await initializeDatabase({ databasePath });
      if (scenario.memory) {
        const { recordEntry } = await import(pathToFileURL(path.join(installed, 'dist/memory/entries.js')).href);
        const { resolveProjectWorkspace } = await import(pathToFileURL(path.join(installed, 'dist/memory/workspaces.js')).href);
        const db = openConnection(databasePath);
        try {
          const project = await resolveProjectWorkspace(db, repo);
          recordEntry(db, { workspace: project.workspace, kind: 'decision', tags: ['shipping', 'shippingFee', 'compatibility'],
            title: scenario.memory === 'related' ? 'Shipping API compatibility' : 'Separate UI project rule',
            body: scenario.memory === 'related' ? 'Existing shippingFee(total) callers must keep their behavior. Add an optional member boolean without changing non-member thresholds; verify backward compatibility.'
              : 'A separate UI project uses blue buttons. This is inapplicable to shipping calculations and grants no editing permission.', confidence: 0.8 });
        } finally { db.close(); }
      }
      const protocol = path.join(scenarioOutput, 'discovery.jsonl');
      const executorOutput=path.join(base,'executor');mkdirSync(executorOutput);
      const config = { 'mcp_servers.kiokuko.command': process.execPath,
        'mcp_servers.kiokuko.args': [path.join(root, 'scripts/lib/normal-workflow/mcp-proxy.mjs'), executable, protocol, scenario.fault ?? 'none'],
        'mcp_servers.kiokuko.env': { KIOKUKO_DATA_DIR: env.KIOKUKO_DATA_DIR, KIOKUKO_SKILL_DISCOVERY: 'off', KIOKUKO_EMBEDDINGS: 'off',
          KIOKUKO_ACCEPTANCE_AUTH_FILE: path.join(env.CODEX_HOME, 'auth.json') },
        'mcp_servers.fixture_executor.command':process.execPath,
        'mcp_servers.fixture_executor.args':[path.join(root,'scripts/lib/normal-workflow/fixture-executor-server.mjs'),repo,executorOutput],
        'mcp_servers.fixture_executor.required':true,
        ...isolatedMcpPolicy(),
        'mcp_servers.kiokuko.required': true, 'features.hooks': true, 'features.multi_agent': false,
        'features.code_mode':false,'features.code_mode_host':true,'features.computer_use':false,'features.browser_use':false,'features.image_generation':false,'features.artifact':false,
        'features.memories': false, 'memories.use_memories': false, 'features.plugins': false, 'features.apps': false,
        'sandbox_workspace_write.exclude_slash_tmp': true, 'sandbox_workspace_write.exclude_tmpdir_env_var': true,
        'sandbox_workspace_write.network_access': false, 'sandbox_workspace_write.writable_roots': [],
        web_search: 'disabled', model: approval.model, model_reasoning_effort: approval.reasoningEffort };
      // Codex loads the installer-generated CODEX_HOME/hooks.json itself.
      // Inline copies would execute every hook twice. Add no workflow prompt.
      const toml = value => Array.isArray(value) ? `[${value.map(toml).join(',')}]`
        : value && typeof value === 'object' ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}` : JSON.stringify(value);
      let cwd = repo;
      if (scenario.location === 'subdirectory') { cwd = path.join(repo, 'nested'); mkdirSync(cwd); }
      const clientArgs = ['exec', '--ignore-user-config', '--dangerously-bypass-hook-trust', '--skip-git-repo-check',
        '--sandbox', 'read-only', '--json', '--cd', cwd,
        ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]), scenario.request];
      const nativeSandboxProbe=probeNativeSandbox({executable:clientExecutable,repo,environment:env,clientVersion:policy.clientVersion});
      if(!sandboxProbeValid(nativeSandboxProbe,policy.clientVersion)) {blocked(client,scenario,'FAIL_HARNESS','Native read-only sandbox enforcement probe failed');continue;}
      const candidateBefore = {...candidate,sourceDigest:sourceFingerprint(root)};
      const started = new Date().toISOString();
      writeFileSync(path.join(scenarioOutput, 'inputs.json'), JSON.stringify({ request: scenario.request, initialTreeHash: treeHash(initial), controlsHash,
        client, version, requestedModel: approval.model, provider: approval.provider, reasoningEffort: approval.reasoningEffort,
        policyHash:policyHash(policy), argv:clientArgs, cwd, modelObserved:false,
        runtime: process.version, platform: process.platform, architecture: process.arch, lockHash: hash(readFileSync(path.join(root, 'package-lock.json'))),
        limits: { maxSeconds: approval.maxSeconds, maxTurns: approval.maxTurns, maxToolCalls: approval.maxToolCalls, maxCost: 0, currency: 'USD' }, started }, null, 2));
      if (Date.now() - overallStarted >= approval.maxTotalSeconds * 1000) { blocked(client, scenario, 'NOT_RUN', 'Approved total time limit reached before client launch'); continue; }
      const session = await runCodex({ executable: clientExecutable, args: clientArgs, cwd, repo, environment: env, output: scenarioOutput,
        limits: { ...approval, maxSeconds: Math.min(approval.maxSeconds, Math.max(1, Math.floor((approval.maxTotalSeconds * 1000 - Date.now() + overallStarted) / 1000))) }, sanitize });
      const final = snapshot(repo); writeFileSync(path.join(scenarioOutput, 'final.json'), JSON.stringify(final));
      const messages = existsSync(protocol) ? readFileSync(protocol, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
      const calls = messages.filter(item => item.direction === 'request' && item.message.method === 'tools/call').map(item => item.message);
      const responseTo = call => messages.find(item => item.direction === 'response' && item.message.id === call.id)?.message.result;
      const successful = name => calls.filter(call => call.params.name === name && responseTo(call)?.isError !== true && responseTo(call));
      const reads = successful('task_inspect').filter(call => call.params.arguments.operation === 'skill');
      const db = openConnection(databasePath, { readOnly: true });
      let observations;
      try { observations = db.prepare('SELECT event_name, tool_name, decision, response_shape FROM codex_hook_observations').all(); }
      finally { db.close(); }
      writeFileSync(path.join(scenarioOutput, 'hooks.json'), JSON.stringify(observations));
      const receipt = collectInstructionReceipt({ codeHome: env.CODEX_HOME, cwd, clientVersion: approval.clientVersion,
        threadId: session.events.find(event => event.type === 'thread.started')?.thread_id, agents: globalAgents, request: scenario.request });
      writeFileSync(path.join(scenarioOutput, 'instruction-receipt.json'), JSON.stringify(receipt));
      if(!['inquiry','conversation'].includes(scenario.kind)) Object.assign(session,bindExecutorCheckpoints(session,{directory:executorOutput,nativeReadonlyObserved:receipt.nativeReadonlyObserved && sandboxProbeValid(nativeSandboxProbe,policy.clientVersion)}));
      // Derive the receipt from the client's initial instruction input, never
      // from the model's attestation or a fabricated JSON-stream event.
      const instructionEvents = receipt.observed ? [{ type: 'instructions.loaded', content_hash: receipt.contentHash }] : [];
      const instructionObservation = observeInstructions({ messages, events: instructionEvents,
        indexes, agentsHash: hash(globalAgents), observations, kind: scenario.kind });
      const { agentsLoadObserved, instructionsVerified } = instructionObservation;
      writeFileSync(path.join(scenarioOutput,'skill-receipts.json'),JSON.stringify(instructionObservation));
      const updatedControls = { agents: readFileSync(path.join(env.CODEX_HOME, 'AGENTS.md'), 'utf8'),
        indexes: indexes.map(index => ({ ...index, text: readFileSync(path.join(env.HOME, '.agents/skills', index.name, 'SKILL.md'), 'utf8') })),
        hooks: JSON.parse(readFileSync(path.join(env.CODEX_HOME, 'hooks.json'), 'utf8')) };
      const memoryReviews = successful('task_memory_review');
      const memoryApplied = memoryReviews.some(call => call.params.arguments.decision === 'adopted' && call.params.arguments.invariant?.includes('shippingFee')
        && call.params.arguments.verification?.length > 0 && call.params.arguments.evidenceIds?.length > 0);
      const memoryInapplicable = memoryReviews.some(call => call.params.arguments.decision === 'inapplicable' && call.params.arguments.basis?.length > 0);
      let oracle;
      try { oracle = evaluateAttempt({ ...session, initial, final, kind: scenario.kind, memory: scenario.memory, fault: scenario.fault,
        controlsUnchanged: hash(JSON.stringify(updatedControls)) === controlsHash, instructionsVerified,
        answerReview:reviews.find(x=>x.id===`${client}/${scenario.id}`)?.review,reviewers:policy.reviewers,
        safe: !session.failure && !messages.some(item => item.type === 'proxy_error'), developmentChecks: calls.some(call => call.params.name === 'task_verification_define'),
        injectedFailures: messages.filter(item => item.type === 'injected_selector').length,
        recovered: reads.length > 0, memoryApplied, memoryInapplicable }, path.join(base, 'oracle')); }
      catch { oracle = { classification: 'FAIL_HARNESS', oraclePassed: false, reason: 'Independent oracle unavailable' }; }
      const candidateAfter = {...candidate,sourceDigest:sourceFingerprint(root),
        dirty:execFileSync('git',['status','--porcelain','--untracked-files=all'],{cwd:root,encoding:'utf8'}).trim() !== ''};
      const raw = { candidateBefore,candidateAfter,artifactHash:hash(readFileSync(tarball)),argv:clientArgs,cwd,requestedModel:policy.model,clientVersion:receipt.clientVersion,provider:policy.provider,reasoningEffort:policy.reasoningEffort,
        policyHash:policyHash(policy),client,request:scenario.request,started,ended:new Date().toISOString(),
        ...session, initial, final, kind:scenario.kind, instructionsVerified,
        controlsBefore:controlsHash,controlsAfter:hash(JSON.stringify(updatedControls)),
        controlsUnchanged:hash(JSON.stringify(updatedControls)) === controlsHash, safe:!session.failure,
        developmentChecks:calls.some(call => call.params.name === 'task_verification_define'),
        injectedFailures:messages.filter(item => item.type === 'injected_selector').length,recovered:reads.length > 0,memoryApplied,memoryInapplicable };
      writeFileSync(path.join(scenarioOutput,'attempt.json'),JSON.stringify(sanitize(raw)));
      writeFileSync(path.join(scenarioOutput,'identity.json'),JSON.stringify({schema:'codex-isolated-identity-v1',model:receipt.model,
        nativeSandboxProbe,nativeReadonlyObserved:receipt.nativeReadonlyObserved,effort:receipt.effort,clientVersion:receipt.clientVersion,modelObserved:receipt.modelObserved,authMode:credentials.auth_mode}));
      writeFileSync(path.join(scenarioOutput, 'oracle.json'), JSON.stringify(oracle, null, 2));
      const errorText = readFileSync(path.join(scenarioOutput, 'stderr.txt'), 'utf8') + JSON.stringify(session.events.filter(event => ['error', 'turn.failed'].includes(event.type)));
      const authBlocked = /not logged in|authentication|unauthorized|invalid.*credential/iu.test(errorText);
      const environmentBlocked = session.failure === 'client_unavailable' || /failed to connect|ENOTFOUND|EAI_AGAIN|model.{0,100}(?:not supported|not available|not found)/iu.test(errorText);
      reports.push({ ...candidate, client, scenario: scenario.id, executionMode: 'live', requestedModel: approval.model, observedModel:receipt.model ?? null, version, policyHash:policyHash(policy),
        classification: candidateAfter.sourceDigest !== candidate.sourceDigest ? 'FAIL_HARNESS' : (!receipt.modelObserved || receipt.model !== policy.model || receipt.effort !== policy.reasoningEffort) ? 'FAIL_HARNESS' : authBlocked ? 'BLOCKED_AUTH' : environmentBlocked ? 'BLOCKED_ENV' : session.failure === 'secret_output' ? 'FAIL_PRODUCT' : !agentsLoadObserved ? 'FAIL_HARNESS' : oracle.classification,
        reason: session.failure ?? (!agentsLoadObserved ? 'AGENTS loading unobserved; a client loader receipt is required' : undefined),
        instructionsVerified, oraclePassed: oracle.oraclePassed, controlsHash, started });
    }
  } else for (const client of clients) for (const scenario of SCENARIOS)
    blocked(client, scenario, (approvalError || policyError) ? 'FAIL_HARNESS' : offline ? 'NOT_RUN' : 'BLOCKED_AUTH',
      approvalError ?? policyError ?? (offline ? 'Offline: no real model executed' : authorized ? 'Test-only ChatGPT credentials unavailable or wrong credential mode' : approvalErrors(approval).join('; ')));
} catch (error) {
  // Preserve every completed attempt; setup failure cannot become a product pass.
  for (const client of clients) for (const scenario of SCENARIOS)
    if (!reports.some(report => report.client === client && report.scenario === scenario.id)) blocked(client, scenario, 'FAIL_HARNESS', 'Isolated setup or artifact creation failed');
  console.error('Acceptance setup failed; inspect the saved summary.');
} finally { if (controls) rmSync(controls, { recursive: true, force: true }); }
const required = policy ? requiredAttempts(policy) : clients.flatMap(client => SCENARIOS.map(scenario => `${client}/${scenario.id}`));
const gate = releaseGate(candidate, reports, required);
const pendingReviews=reports.filter(x=>x.classification==='WAITING_REVIEW').map(report=> {
  const attempt=JSON.parse(readFileSync(path.join(output,report.scenario,'attempt.json'),'utf8'));
  return {id:`${report.client}/${report.scenario}`,kind:attempt.kind,answer:attempt.answer,answerHash:hash(attempt.answer),initialHash:treeHash(attempt.initial),specHash:hash(attempt.initial['README.md']),rubricVersion:policy.rubricVersion};
});
writeFileSync(path.join(output,'review-requests.json'),JSON.stringify(pendingReviews,null,2));
const collectionComplete=reports.every(x=>['PASS','WAITING_REVIEW'].includes(x.classification));
const summary = { phase:pendingReviews.length?'WAITING_REVIEW':'COLLECTED', candidate, clients, required, reports, configurationHash, policyHash:policy ? policyHash(policy) : null, liveGate: gate, releaseReady: false,
  reason: 'G0-G2 evidence must also match this candidate; this runner reports G3/G4 only.' };
writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ output, livePassed: gate.passed, releaseReady: false, classifications: reports.map(report => `${report.client}/${report.scenario}: ${report.classification}`) }, null, 2));
// Offline is allowed as an infrastructure check, but never as a release check.
process.exitCode = args.includes('--collect-only') && !offline && collectionComplete ? 0 : args.includes('--require-live') || !offline || approvalError ? (gate.passed ? 0 : 1) : 0;
