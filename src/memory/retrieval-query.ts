import { KiokukoError } from '../errors.js';

const MAX_QUERY_BYTES = 16 * 1024;
const MAX_TERMS = 64;
const MAX_TERM_LENGTH = 512;
const STRUCTURED_SIGNAL = /(?:sqlstate\[[^\]]+\]|(?:[a-z_$][\w$]*)(?:::|->)[\w$:.()\\-]+|(?:[a-z_$][\w$]*\\)+[\w$.-]+|(?:^|\s)\/[\w./-]+|@[A-Za-z][\w.-]*|\$[A-Za-z_][\w$]*|[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)/gu;

export interface ParsedExactSignal {
  type: 'symbol' | 'path' | 'error' | 'package' | 'command' | 'unknown';
  value: string;
  normalizedValue: string;
}

export interface ParsedRetrievalQuery {
  raw: string;
  normalized: string;
  lexicalTerms: string[];
  phraseTerms: string[];
  substringTerms: string[];
  exactSignals: ParsedExactSignal[];
}

function invalid(): never {
  throw new KiokukoError('VALIDATION_ERROR', 'Search query is invalid');
}

function normalize(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function normalizedSignal(value: string): string {
  return normalize(value).toLowerCase();
}

function signalType(value: string): ParsedExactSignal['type'] {
  if (/^sqlstate\[/iu.test(value) || /\b(?:error|exception|fatal|e\d{3,})\b/iu.test(value)) return 'error';
  if (value.includes('/') && !value.startsWith('@')) return value.startsWith('/') || value.includes('\\') ? 'path' : 'package';
  if (value.startsWith('@') || value.startsWith('$')) return 'symbol';
  if (value.includes('::') || value.includes('->')) return 'symbol';
  if (/\s/.test(value)) return 'command';
  return 'unknown';
}

function unique(values: string[]): string[] {
  return [...new Set(values)].filter((value) => value.length > 0).slice(0, MAX_TERMS);
}

export function parseRetrievalQuery(input: unknown): ParsedRetrievalQuery {
  if (typeof input !== 'string') invalid();
  if (input.length === 0 || Buffer.byteLength(input, 'utf8') > MAX_QUERY_BYTES) invalid();
  const raw = input;
  const normalized = normalize(input);
  if (normalized.length === 0) {
    return { raw, normalized, lexicalTerms: [], phraseTerms: [], substringTerms: [], exactSignals: [] };
  }

  const exactValues = [...normalized.matchAll(STRUCTURED_SIGNAL)]
    .map((match) => match[0].trim())
    .filter((value) => value.length > 1 && value.length <= MAX_TERM_LENGTH);
  const exactSignals = unique(exactValues).map((value) => ({
    type: signalType(value),
    value,
    normalizedValue: normalizedSignal(value),
  }));

  const lexicalTerms = unique(normalized.match(/[\p{L}\p{N}_$@]+/gu) ?? [])
    .map((term) => term.slice(0, MAX_TERM_LENGTH));
  const phraseTerms = unique(normalized.split(/\s+/u).filter((term) => term.length > 1))
    .map((term) => term.slice(0, MAX_TERM_LENGTH));
  const substringTerms = unique([
    ...exactSignals.map((signal) => signal.value),
    ...(normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/gu) ?? []),
    ...lexicalTerms.filter((term) => term.length >= 2),
  ]).map((term) => term.slice(0, MAX_TERM_LENGTH));

  return { raw, normalized, lexicalTerms, phraseTerms, substringTerms, exactSignals };
}

export function normalizeSearchSignal(value: string): string {
  return normalizedSignal(value);
}

export const RETRIEVAL_LIMITS = Object.freeze({
  maxQueryBytes: MAX_QUERY_BYTES,
  maxTerms: MAX_TERMS,
  maxTermLength: MAX_TERM_LENGTH,
});
