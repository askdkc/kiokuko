import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  loadBundledStandardSkillFiles,
  STANDARD_UI_SKILL_FILES,
  STANDARD_UI_SKILL_MANAGED_MARKER,
  STANDARD_UI_SKILL_NAME,
} from '../../src/setup/standard-skills.js';

test('bundles a complete managed UI skill from a fixed manifest', async () => {
  const files = await loadBundledStandardSkillFiles();
  assert.deepEqual(files.map((file) => file.relativePath), [...STANDARD_UI_SKILL_FILES]);
  for (const file of files) {
    assert.equal(file.content.split(STANDARD_UI_SKILL_MANAGED_MARKER).length - 1, 1);
    assert.doesNotMatch(file.content, /\b(?:TODO|TBD|FIXME|PLACEHOLDER)\b/);
  }

  const skill = files.find((file) => file.relativePath === 'SKILL.md')?.content ?? '';
  assert.match(skill, new RegExp(`^---\\nname: ${STANDARD_UI_SKILL_NAME}\\ndescription: [^\\n]+\\n---\\n`));
  assert.match(skill, /references\/ui-checklist\.md/);
  assert.match(skill, /Reduced Motion/);
  assert.match(skill, /WCAG 2\.2/);

  const checklist = files.find((file) => file.relativePath === 'references/ui-checklist.md')?.content ?? '';
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
});

test('the packaged skill source remains readable at its repository location', async () => {
  const skill = await readFile(new URL('../../skills/kiokuko-ui-design-soul/SKILL.md', import.meta.url), 'utf8');
  assert.match(skill, /^---\nname: kiokuko-ui-design-soul\n/);
});
