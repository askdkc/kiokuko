import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KiokukoError } from '../errors.js';

export const STANDARD_UI_SKILL_NAME = 'kiokuko-ui-design-soul';
export const STANDARD_UI_SKILL_MANAGED_MARKER = '<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-ui-design-soul -->';
export const STANDARD_UI_SKILL_FILES = ['SKILL.md', 'references/ui-checklist.md'] as const;
export const STANDARD_FUNCTION_SKILL_NAME = 'kiokuko-single-purpose-functions';
export const STANDARD_FUNCTION_SKILL_MANAGED_MARKER = '<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->';
export const STANDARD_FUNCTION_SKILL_FILES = [
  'SKILL.md',
  'references/kiokuko-patterns.md',
  'references/review-checklist.md',
] as const;

interface StandardSkillManifest {
  readonly name: string;
  readonly managedMarker: string;
  readonly files: readonly string[];
}

export const STANDARD_SKILL_MANIFESTS = [{
  name: STANDARD_UI_SKILL_NAME,
  managedMarker: STANDARD_UI_SKILL_MANAGED_MARKER,
  files: STANDARD_UI_SKILL_FILES,
}, {
  name: STANDARD_FUNCTION_SKILL_NAME,
  managedMarker: STANDARD_FUNCTION_SKILL_MANAGED_MARKER,
  files: STANDARD_FUNCTION_SKILL_FILES,
}] as const satisfies readonly StandardSkillManifest[];

export interface BundledStandardSkillFile {
  readonly skillName: string;
  readonly managedMarker: string;
  readonly relativePath: string;
  readonly content: string;
}

function standardSkillRoot(skillName: string): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDirectory, '..', '..', 'skills', skillName);
}

function markerCount(content: string, managedMarker: string): number {
  return content.split(managedMarker).length - 1;
}

async function loadBundledStandardSkill(
  manifest: StandardSkillManifest,
): Promise<BundledStandardSkillFile[]> {
  const root = standardSkillRoot(manifest.name);
  return Promise.all(manifest.files.map(async (relativePath) => {
    let content: string;
    try {
      content = await readFile(path.join(root, relativePath), 'utf8');
    } catch {
      throw new KiokukoError('INTEGRITY_ERROR', `Bundled standard skill file is unavailable: ${manifest.name}/${relativePath}`);
    }
    if (markerCount(content, manifest.managedMarker) !== 1) {
      throw new KiokukoError('INTEGRITY_ERROR', `Bundled standard skill file has an invalid management marker: ${manifest.name}/${relativePath}`);
    }
    return {
      skillName: manifest.name,
      managedMarker: manifest.managedMarker,
      relativePath,
      content,
    };
  }));
}

export async function loadBundledStandardSkillFiles(): Promise<BundledStandardSkillFile[]> {
  return (await Promise.all(STANDARD_SKILL_MANIFESTS.map(loadBundledStandardSkill))).flat();
}

export function renderStandardSkillFile(
  existing: string | undefined,
  bundled: BundledStandardSkillFile,
): { content: string; action: 'created' | 'updated' | 'unchanged' } {
  if (existing === undefined) return { content: bundled.content, action: 'created' };
  if (markerCount(existing, bundled.managedMarker) !== 1) {
    throw new KiokukoError('CONFLICT', `Refusing to overwrite an unmanaged standard skill file: ${bundled.skillName}/${bundled.relativePath}`);
  }
  return {
    content: bundled.content,
    action: existing === bundled.content ? 'unchanged' : 'updated',
  };
}
