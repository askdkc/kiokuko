import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { KiokukoError } from '../errors.js';
import type { DelimitedBlockResult } from './managed-text.js';

export function renderOpenCodeConfig(existing: string | undefined, command = 'kiokuko'): DelimitedBlockResult {
  const source = existing === undefined || existing.trim().length === 0
    ? '{\n  "$schema": "https://opencode.ai/config.json"\n}\n'
    : existing;
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KiokukoError('VALIDATION_ERROR', 'OpenCode config is not a valid JSON/JSONC object');
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const edits = modify(source, ['mcp', 'kiokuko'], {
    type: 'local',
    command: [command, 'mcp'],
    enabled: true,
  }, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  });
  const content = applyEdits(source, edits);
  return {
    content,
    action: existing === undefined ? 'created' : content === existing ? 'unchanged' : 'updated',
  };
}
