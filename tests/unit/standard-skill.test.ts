import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  loadBundledStandardSkillFiles,
  STANDARD_FUNCTION_SKILL_FILES,
  STANDARD_FUNCTION_SKILL_MANAGED_MARKER,
  STANDARD_FUNCTION_SKILL_NAME,
  STANDARD_SKILL_MANIFESTS,
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
  assert.doesNotMatch(functionSkill, /TypeScript in Kiokuko|Build Kiokuko by composing/u);
  assert.match(functionFiles.find((file) => file.relativePath === 'references/kiokuko-patterns.md')?.content ?? '', /Hostile boundary, constrained private core/);
  assert.match(functionFiles.find((file) => file.relativePath === 'references/kiokuko-patterns.md')?.content ?? '', /language-agnostic contracts illustrated with TypeScript/);
  assert.match(functionFiles.find((file) => file.relativePath === 'references/review-checklist.md')?.content ?? '', /Function-contract coding and review checklist/);
  assert.match(functionFiles.find((file) => file.relativePath === 'references/review-checklist.md')?.content ?? '', /any language or repository/);
});

test('the packaged skill sources remain readable at their repository locations', async () => {
  const [uiSkill, functionSkill] = await Promise.all([
    readFile(new URL('../../skills/kiokuko-ui-design-soul/SKILL.md', import.meta.url), 'utf8'),
    readFile(new URL('../../skills/kiokuko-single-purpose-functions/SKILL.md', import.meta.url), 'utf8'),
  ]);
  assert.match(uiSkill, /^---\nname: kiokuko-ui-design-soul\n/);
  assert.match(functionSkill, /^---\nname: kiokuko-single-purpose-functions\n/);
});
