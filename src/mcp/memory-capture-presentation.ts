import type * as z from 'zod/v4';
import type { interactionMemorySchema } from '../memory/interaction-contract.js';

type Memory = Omit<z.output<typeof interactionMemorySchema>, 'scope'> & { scope?: 'project' | 'global' };
export interface MemoryCaptureProposal {
  operationId: string;
  memories: Memory[];
}

// Native elicitation is rendered by the host. It offers no scroll/layout API.
// Bound both text size and estimated wrapped lines rather than clipping consent.
const MAX_REVIEW_CHARACTERS = 1600;
const MAX_REVIEW_LINES = 24;
const REVIEW_COLUMNS = 72;

const labels = {
  title: 'Title', body: 'Remember', summary: 'Why remember this', kind: 'Type',
  scope: 'Use in', subjects: 'Topics', basis: 'Based on', portableReason: 'Applies elsewhere because',
  retrievalScope: 'Where it may be recalled', tags: 'Labels', memoryClass: 'Category',
  applicability: 'Only applies to', signals: 'Find this when matching',
  generalCommunication: 'Communication preference', replaces: 'Replaces existing memory',
  reinforces: 'Adds evidence to existing memory',
} satisfies Record<keyof Memory, string>;

const basisLabels = {
  user_statement: 'Your statement', user_correction: 'Your correction',
  observed_result: 'Observed result reported by the assistant',
};

function detailText(value: unknown): string {
  if (Array.isArray(value)) return value.map(detailText).join('; ');
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).map(([key, item]) =>
      `${key.replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase()}: ${detailText(item)}`).join('; ');
  }
  return String(value);
}

function memoryReviewText(memory: Memory, index: number): string {
  const lines = [
    `${index + 1}. ${memory.title}`,
    `Remember: ${memory.body}`,
    ...(memory.summary ? [`Why remember this: ${memory.summary}`] : []),
    `Use in: ${memory.scope === 'project' ? 'This project' : 'All projects and conversations'}`,
    `Based on: ${basisLabels[memory.basis]}`,
  ];
  for (const [key, value] of Object.entries(memory)) {
    if (value === undefined || ['title', 'body', 'summary', 'scope', 'basis'].includes(key)) continue;
    if (key === 'generalCommunication') {
      if (value === true) lines.push('Applies to all communication');
      continue;
    }
    lines.push(`${labels[key as keyof Memory]}: ${detailText(value)}`);
  }
  return lines.join('\n');
}

/** The complete human-facing content, or no prompt when it cannot fit. */
export function memoryCaptureReviewMessage(proposal: MemoryCaptureProposal): string | undefined {
  const message = [
    'Remember this for future conversations?',
    'Save stores all items below. Decline saves nothing.',
    '',
    ...proposal.memories.map(memoryReviewText),
  ].join('\n');
  return fitsNativeReview(message) ? message : undefined;
}

export function fitsNativeReview(message: string): boolean {
  // Count non-ASCII conservatively as two columns (including CJK and emoji).
  const lines = message.split(/\r\n|[\n\r\u2028\u2029]/u).reduce((count, line) => {
    const width = Array.from(line).reduce((total, character) => total + (character.codePointAt(0)! > 0x7f ? 2 : 1), 0);
    return count + Math.max(1, Math.ceil(width / REVIEW_COLUMNS));
  }, 0);
  return message.length <= MAX_REVIEW_CHARACTERS && lines <= MAX_REVIEW_LINES;
}
