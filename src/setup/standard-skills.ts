import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KiokukoError } from '../errors.js';

export const STANDARD_UI_SKILL_NAME = 'kiokuko-ui-design-soul';
export const STANDARD_UI_SKILL_MANAGED_MARKER = '<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-ui-design-soul -->';
export const STANDARD_UI_SKILL_FILES = ['SKILL.md', 'references/ui-checklist.md'] as const;

export interface BundledStandardSkillFile {
  relativePath: (typeof STANDARD_UI_SKILL_FILES)[number];
  content: string;
}

function standardSkillRoot(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDirectory, '..', '..', 'skills', STANDARD_UI_SKILL_NAME);
}

function markerCount(content: string): number {
  return content.split(STANDARD_UI_SKILL_MANAGED_MARKER).length - 1;
}

export async function loadBundledStandardSkillFiles(): Promise<BundledStandardSkillFile[]> {
  const root = standardSkillRoot();
  return Promise.all(STANDARD_UI_SKILL_FILES.map(async (relativePath) => {
    let content: string;
    try {
      content = await readFile(path.join(root, relativePath), 'utf8');
    } catch {
      throw new KiokukoError('INTEGRITY_ERROR', `Bundled standard skill file is unavailable: ${relativePath}`);
    }
    if (markerCount(content) !== 1) {
      throw new KiokukoError('INTEGRITY_ERROR', `Bundled standard skill file has an invalid management marker: ${relativePath}`);
    }
    return { relativePath, content };
  }));
}

export function renderStandardSkillFile(
  existing: string | undefined,
  bundled: BundledStandardSkillFile,
): { content: string; action: 'created' | 'updated' | 'unchanged' } {
  if (existing === undefined) return { content: bundled.content, action: 'created' };
  if (markerCount(existing) !== 1) {
    throw new KiokukoError('CONFLICT', `Refusing to overwrite an unmanaged standard skill file: ${bundled.relativePath}`);
  }
  return {
    content: bundled.content,
    action: existing === bundled.content ? 'unchanged' : 'updated',
  };
}
