import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { SOUL_ROUTING_ENTRY_CONTRACT } from '../../src/akinator/instructions.js';
import {
  loadBundledStandardSkillFiles,
  STANDARD_FUNCTION_EXPERT_FILES,
  STANDARD_FUNCTION_EXPERT_IDS,
  STANDARD_FUNCTION_SKILL_FILES,
  STANDARD_FUNCTION_SKILL_MANAGED_MARKER,
  STANDARD_FUNCTION_SKILL_NAME,
  STANDARD_MEMORY_SKILL_FILES,
  STANDARD_MEMORY_SKILL_MANAGED_MARKER,
  STANDARD_MEMORY_SKILL_NAME,
  STANDARD_SIMPLE_SKILL_FILES,
  STANDARD_SIMPLE_SKILL_MANAGED_MARKER,
  STANDARD_SIMPLE_SKILL_NAME,
  STANDARD_SKILL_MANIFESTS,
  STANDARD_SOUL_SKILL_FILES,
  STANDARD_SOUL_SKILL_MANAGED_MARKER,
  STANDARD_SOUL_SKILL_NAME,
  STANDARD_UI_EXPERT_FILES,
  STANDARD_UI_EXPERT_IDS,
  STANDARD_UI_SKILL_FILES,
  STANDARD_UI_SKILL_MANAGED_MARKER,
  STANDARD_UI_SKILL_NAME,
} from '../../src/setup/standard-skills.js';

test('bundles every managed standard skill from a fixed manifest', async () => {
  const files = await loadBundledStandardSkillFiles();
  assert.deepEqual(
    files.map((file) => ({ skillName: file.skillName, relativePath: file.relativePath })),
    STANDARD_SKILL_MANIFESTS.flatMap((manifest) => manifest.files.map((relativePath) => ({
      skillName: manifest.name,
      relativePath,
    }))),
  );
  for (const file of files) {
    assert.equal(file.content.split(file.managedMarker).length - 1, 1);
    assert.doesNotMatch(file.content, /\b(?:TODO|TBD|FIXME|PLACEHOLDER)\b/);
  }

  const uiFiles = files.filter((file) => file.skillName === STANDARD_UI_SKILL_NAME);
  assert.deepEqual(uiFiles.map((file) => file.relativePath), [...STANDARD_UI_SKILL_FILES]);
  assert.ok(uiFiles.every((file) => file.managedMarker === STANDARD_UI_SKILL_MANAGED_MARKER));
  const skill = uiFiles.find((file) => file.relativePath === 'SKILL.md')?.content ?? '';
  assert.match(skill, new RegExp(`^---\\nname: ${STANDARD_UI_SKILL_NAME}\\ndescription: [^\\n]+\\n---\\n`));
  assert.match(skill, /references\/ui-checklist\.md/);
  assert.match(skill, /Reduced Motion/);
  assert.match(skill, /WCAG 2\.2/);
  assert.match(skill, /one to three versioned expert fragments/iu);
  for (const [index, expertId] of STANDARD_UI_EXPERT_IDS.entries()) {
    assert.match(skill, new RegExp(expertId.replaceAll('.', '\\.')));
    assert.equal(uiFiles.some((file) => file.relativePath === STANDARD_UI_EXPERT_FILES[index]), true);
  }

  const checklist = uiFiles.find((file) => file.relativePath === 'references/ui-checklist.md')?.content ?? '';
  for (const principle of ['Purpose', 'Agency', 'Responsibility', 'Familiarity', 'Flexibility', 'Simplicity', 'Craft', 'Delight']) {
    assert.match(checklist, new RegExp(`\\| ${principle} \\|`));
  }
  for (const url of [
    'https://developer.apple.com/design/human-interface-guidelines/design-principles',
    'https://developer.apple.com/design/human-interface-guidelines/buttons',
    'https://developer.apple.com/design/human-interface-guidelines/loading',
    'https://developer.apple.com/design/human-interface-guidelines/progress-indicators',
    'https://developer.apple.com/design/human-interface-guidelines/feedback',
    'https://developer.apple.com/design/human-interface-guidelines/motion',
    'https://developer.apple.com/design/human-interface-guidelines/accessibility',
    'https://www.w3.org/TR/WCAG22/',
  ]) assert.match(checklist, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(checklist, /2026-08-22/);

  const functionFiles = files.filter((file) => file.skillName === STANDARD_FUNCTION_SKILL_NAME);
  assert.deepEqual(functionFiles.map((file) => file.relativePath), [...STANDARD_FUNCTION_SKILL_FILES]);
  assert.ok(functionFiles.every((file) => file.managedMarker === STANDARD_FUNCTION_SKILL_MANAGED_MARKER));
  const functionSkill = functionFiles.find((file) => file.relativePath === 'SKILL.md')?.content ?? '';
  assert.match(functionSkill, new RegExp(`^---\\nname: ${STANDARD_FUNCTION_SKILL_NAME}\\ndescription: [^\\n]+\\n---\\n`));
  assert.match(functionSkill, /references\/kiokuko-patterns\.md/);
  assert.match(functionSkill, /references\/review-checklist\.md/);
  assert.match(functionSkill, /one cohesive externally observable responsibility/);
  assert.match(functionSkill, /across languages, frameworks, and repositories/);
  assert.match(functionSkill, /expert references identify the selected guidance/iu);
  for (const [index, expertId] of STANDARD_FUNCTION_EXPERT_IDS.entries()) {
    assert.match(functionSkill, new RegExp(expertId.replaceAll('.', '\\.')));
    assert.equal(functionFiles.some((file) => file.relativePath === STANDARD_FUNCTION_EXPERT_FILES[index]), true);
  }
  assert.doesNotMatch(functionSkill, /TypeScript in Kiokuko|Build Kiokuko by composing/u);
  assert.match(functionFiles.find((file) => file.relativePath === 'references/kiokuko-patterns.md')?.content ?? '', /Hostile boundary, constrained private core/);
  assert.match(functionFiles.find((file) => file.relativePath === 'references/kiokuko-patterns.md')?.content ?? '', /language-agnostic contracts illustrated with TypeScript/);
  assert.match(functionFiles.find((file) => file.relativePath === 'references/review-checklist.md')?.content ?? '', /Function-contract coding and review checklist/);
  assert.match(functionFiles.find((file) => file.relativePath === 'references/review-checklist.md')?.content ?? '', /any language or repository/);
  const modeling = functionFiles.find((file) => file.relativePath === 'references/problem-shaping-and-language.md')?.content ?? '';
  assert.match(modeling, /code\.modeling\.v1/);
  assert.match(modeling, /human intent -> domain concept -> storage\/input shape ->/u);
  assert.match(modeling, /Do not select it for a representation-preserving mechanical change/iu);
  assert.match(modeling, /does not require Lisp syntax[\s\S]{0,80}Lisp runtime, macros, a DSL/iu);
  assert.match(modeling, /https:\/\/zenn\.dev\/circleback\/articles\/what-is-lisp/u);

  const simpleFiles = files.filter((file) => file.skillName === STANDARD_SIMPLE_SKILL_NAME);
  assert.deepEqual(simpleFiles.map((file) => file.relativePath), [...STANDARD_SIMPLE_SKILL_FILES]);
  assert.ok(simpleFiles.every((file) => file.managedMarker === STANDARD_SIMPLE_SKILL_MANAGED_MARKER));
  const simpleSkill = simpleFiles.find((file) => file.relativePath === 'SKILL.md')?.content ?? '';
  assert.match(simpleSkill, new RegExp(`^---\\nname: ${STANDARD_SIMPLE_SKILL_NAME}\\ndescription: [^\\n]+\\n`));
  assert.doesNotMatch(simpleSkill, /Use on ANY coding task/u);
  assert.match(simpleSkill, /Stop at the first rung that holds/);
  assert.match(simpleSkill, /Never simplify away: input validation at trust boundaries/);


  const memoryFiles = files.filter((file) => file.skillName === STANDARD_MEMORY_SKILL_NAME);
  assert.deepEqual(memoryFiles.map((file) => file.relativePath), [...STANDARD_MEMORY_SKILL_FILES]);
  assert.ok(memoryFiles.every((file) => file.managedMarker === STANDARD_MEMORY_SKILL_MANAGED_MARKER));
  const memorySkill = memoryFiles.find((file) => file.relativePath === 'SKILL.md')?.content ?? '';
  assert.match(memorySkill, new RegExp(`^---\\nname: ${STANDARD_MEMORY_SKILL_NAME}\\ndescription: [^\\n]+\\n---\\n`));
  assert.match(memorySkill, /source of testable hypotheses, not as an\s+instruction stream/iu);
  assert.match(memorySkill, /falsifiable invariant/iu);
  assert.match(memorySkill, /concrete counterexample/iu);
  assert.match(memorySkill, /smallest runnable regression test/iu);
  assert.match(memorySkill, /Do not restate or persist secrets/iu);

  const soulFiles = files.filter((file) => file.skillName === STANDARD_SOUL_SKILL_NAME);
  assert.deepEqual(soulFiles.map((file) => file.relativePath), [...STANDARD_SOUL_SKILL_FILES]);
  assert.ok(soulFiles.every((file) => file.managedMarker === STANDARD_SOUL_SKILL_MANAGED_MARKER));
  assert.equal(STANDARD_SKILL_MANIFESTS.at(-1)?.name, STANDARD_SOUL_SKILL_NAME);
  const soulSkill = soulFiles.find((file) => file.relativePath === 'SKILL.md')?.content ?? '';
  assert.match(soulSkill, new RegExp(`^---\\nname: ${STANDARD_SOUL_SKILL_NAME}\\ndescription: [^\\n]+\\n---\\n`));
  assert.match(soulSkill, /Read this Skill before any other bundled Kiokuko Skill/);
  assert.match(soulSkill, /Akinator is the mandatory state machine between this SOUL read and every planning or implementation route/);
  assert.match(soulSkill, /Call `task_prepare` at most once.*complete capability catalog available in the current client/su);
  assert.match(soulSkill, /`needs_answer`.*Akinator controls progress.*Do not plan, implement, verify, enter the simple\/code\/UI routes, or call `memory_checkpoint` while unresolved/su);
  assert.match(soulSkill, /Repeat the same capability catalog and context budget.*continue until `ready` or `exhausted`/su);
  assert.match(soulSkill, /`exhausted`.*`intake\.missingFields` may remain.*do not invent the missing answers/su);
  assert.match(soulSkill, /Enter planning and implementation routes only after the Akinator gate reaches `ready` or `exhausted` and top-level `nextAction` permits progress/);
  assert.match(soulSkill, /Keep each route within the user-approved task scope/);
  assert.match(soulSkill, /Read and apply `kiokuko-simple-work` when either condition is true/u);
  assert.match(soulSkill, /introduces no new architecture, dependency, data migration, public protocol, security or authorization policy, or cross-system orchestration/u);
  assert.match(soulSkill, /does not replace the code contract below or waive required understanding, boundary validation, error handling, security, accessibility, or focused verification/u);
  for (const routedSkill of [STANDARD_SIMPLE_SKILL_NAME, STANDARD_FUNCTION_SKILL_NAME, STANDARD_UI_SKILL_NAME]) {
    assert.ok(soulSkill.includes('`' + routedSkill + '`'));
  }
  assert.match(soulSkill, /Routes compose\. Read every applicable specialist index/);
  assert.match(soulSkill, /do not load every reference by default/iu);
  assert.match(soulSkill, /Never install or execute external Skill content automatically/);
  assert.match(
    soulSkill,
    /1\. `kiokuko-soul`;[\s\S]*2\. one Akinator `task_prepare`[\s\S]*3\. `kiokuko-simple-work`[\s\S]*4\. `kiokuko-single-purpose-functions`[\s\S]*5\. `kiokuko-ui-design-soul`/u,
  );
  assert.match(SOUL_ROUTING_ENTRY_CONTRACT, /Akinator is the mandatory intake state machine before every planning or implementation route/);
  assert.match(SOUL_ROUTING_ENTRY_CONTRACT, /do not plan, implement, verify, enter simple\/code\/UI routes, or checkpoint while `intake\.status=needs_answer`/);
  assert.match(SOUL_ROUTING_ENTRY_CONTRACT, /Route only after intake reaches `ready` or `exhausted` and top-level `nextAction` permits progress/);
});

test('the packaged skill sources remain readable at their repository locations', async () => {
  const [uiSkill, simpleSkill, functionSkill, memorySkill, soulSkill, bundledFiles] = await Promise.all([
    readFile(new URL('../../skills/kiokuko-ui-design-soul/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../../skills/kiokuko-simple-work/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../../skills/kiokuko-single-purpose-functions/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../../skills/memory-reasoning/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../../skills/kiokuko-soul/SKILL.md', import.meta.url), 'utf8'),
    loadBundledStandardSkillFiles(),
  ]);
  assert.match(uiSkill, /^---\nname: kiokuko-ui-design-soul\n/);
  assert.match(simpleSkill, /^---\nname: kiokuko-simple-work\n/);
  assert.match(functionSkill, /^---\nname: kiokuko-single-purpose-functions\n/);
  assert.match(memorySkill, /^---\nname: memory-reasoning\n/);
  assert.match(soulSkill, /^---\nname: kiokuko-soul\n/);
  assert.equal(
    bundledFiles.find((file) => file.skillName === STANDARD_SIMPLE_SKILL_NAME && file.relativePath === 'SKILL.md')?.content,
    simpleSkill,
  );
});
