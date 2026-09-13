import assert from 'node:assert/strict';
import { fixture, capabilities, base, printReport } from './akinator-memory-fixture.mjs';
import { probeProfileMemory } from '../dist/akinator/memory-probe.js';
import { evaluateProfile } from '../dist/akinator/domain.js';
import { syncProfileDocument } from '../dist/akinator/profile-memory-store.js';

const cases = [
  { name: 'literal path', query: 'src/feature.ts', expected: 'src/feature.ts', recall: true },
  { name: 'Japanese literal path', query: 'src/feature.ts を修正', expected: 'src/feature.ts', recall: true },
  { name: 'unknown target', query: '別の対象', expected: null, recall: false },
  { name: 'explicit current target', query: 'src/feature.ts', profile: { ...base, target: 'src/current.ts' }, expected: 'src/current.ts', recall: false },
  { name: 'missing capability', query: 'src/feature.ts', capabilities: [], expected: null, recall: false },
  { name: 'partial projection', query: 'src/feature.ts', partial: true, expected: null, recall: true },
  { name: 'failed source run', query: 'src/feature.ts', status: 'failed', expected: null, recall: true },
  { name: 'memory provenance chain', query: 'src/feature.ts', memory: true, expected: null, recall: true },
  { name: 'past expected is not current success', query: 'src/feature.ts', profile: { ...base, expected: null }, expected: 'src/feature.ts', recall: true },
  { name: 'suggest does not adopt', query: 'src/feature.ts', mode: 'suggest', expected: null, recall: true },
  { name: 'shadow does not adopt', query: 'src/feature.ts', mode: 'shadow', expected: null, recall: true },
  { name: 'off skips', query: 'src/feature.ts', mode: 'off', expected: null, recall: false },
];
const results = [];
for (const scenario of cases) {
  const f = await fixture();
  try {
    const source = f.addProfile('src/feature.ts', scenario.status);
    if (scenario.partial) f.database.prepare('UPDATE akinator_profile_projection_state SET complete = 0').run();
    if (scenario.memory) {
      f.database.prepare("UPDATE run_intakes SET profile_sources_json = json_set(profile_sources_json, '$.target', 'memory') WHERE run_id = ?").run(source.runId);
      syncProfileDocument(f.database, f.scope.workspace, source.runId);
    }
    const profile = scenario.profile ?? base;
    const result = probeProfileMemory(f.database, scenario.query, profile, { scope: f.scope, mode: scenario.mode ?? 'resolve', capabilities: scenario.capabilities ?? capabilities });
    const recalled = result.resolution.candidates.slice(0, 3).some(candidate => candidate.runId === source.runId);
    assert.equal(result.profile.target, scenario.expected, scenario.name);
    assert.equal(result.profile.expected, profile.expected, scenario.name);
    assert.equal(recalled, scenario.recall, scenario.name);
    assert.ok(result.resolution.metrics.expandedProfiles <= 64);
    results.push({ case: scenario.name, correct: true, adopted: result.resolution.adoptedRunId !== null,
      recallAt3: scenario.recall ? Number(recalled) : null,
      missingBefore: evaluateProfile(profile, 0).missingFields.length,
      missingAfter: evaluateProfile(result.profile, 0).missingFields.length,
      ...result.resolution.metrics });
  } finally { await f.close(); }
}
printReport({ policy: 'profile-memory-v1', cases: results.length,
  correct: results.length, incorrectAdoptions: 0,
  note: 'Synthetic deterministic cases. Missing fields are not measured human question counts. User correction rates and real-world error probabilities are unmeasured.', results });
