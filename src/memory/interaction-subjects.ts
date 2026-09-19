import { KiokukoError } from '../errors.js';
import type { EntryRecord } from './entries.js';

export const INTERACTION_SOURCE = 'interaction_capture';
export const GENERAL_COMMUNICATION_TAG = 'preference:general-communication';

export function normalizeSubject(value: string): string {
  const subject = value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, '-');
  if (!subject || subject.length > 80 || /[\p{C}:]/u.test(subject)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Subject must be bounded text without control characters or colons');
  }
  return subject;
}

export function memorySubjects(entry: Pick<EntryRecord, 'tags'>): string[] {
  return entry.tags.filter((tag) => tag.startsWith('subject:')).map((tag) => tag.slice(8));
}

export function isGeneralCommunicationPreference(entry: EntryRecord): boolean {
  return entry.kind === 'preference' && entry.provenance.type === INTERACTION_SOURCE
    && entry.scope.visibility === 'global' && entry.scope.memoryClass === 'preference'
    && entry.tags.includes(GENERAL_COMMUNICATION_TAG) && memorySubjects(entry).length === 0;
}

/** Subject preferences require an explicit filter or a literal subject mention. */
export function matchesInteractionSubject(entry: EntryRecord, query: string, subjects?: readonly string[]): boolean {
  const stored = memorySubjects(entry);
  if (subjects !== undefined) return stored.some((subject) => subjects.includes(subject));
  if (entry.kind !== 'preference' || stored.length === 0) return true;
  const text = query.normalize('NFKC').toLowerCase().replace(/\s+/gu, '-');
  return stored.some((subject) => {
    const escaped = subject.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    // CJK has no dependable word boundaries; other labels must match a whole label.
    return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(subject)
      ? text.includes(subject)
      : new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(text);
  });
}
