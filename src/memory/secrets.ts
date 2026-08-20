export interface SecretFinding {
  kind: 'private_key' | 'authorization_header' | 'credential_assignment' | 'known_token_prefix';
}

const PATTERNS: Array<[SecretFinding['kind'], RegExp]> = [
  ['private_key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i],
  ['authorization_header', /\bauthorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{12,}/i],
  ['known_token_prefix', /\b(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,})\b/],
  ['credential_assignment', /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=:-]{12,}/i],
];

export function findSecret(value: string): SecretFinding | undefined {
  for (const [kind, pattern] of PATTERNS) {
    if (pattern.test(value)) return { kind };
  }
  return undefined;
}

export function containsSecret(value: string): boolean {
  return findSecret(value) !== undefined;
}
