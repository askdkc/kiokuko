import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { KiokukoError } from '../errors.js';
import type { DelimitedBlockResult } from './managed-text.js';

export function renderClaudeConfig(existing: string | undefined, command = 'kiokuko'): DelimitedBlockResult {
  const source = existing === undefined || existing.trim().length === 0 ? '{}\n' : existing;
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: false, disallowComments: true });
  if (errors.length > 0 || typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KiokukoError('VALIDATION_ERROR', 'Claude user config is not a valid JSON object');
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const edits = modify(source, ['mcpServers', 'kiokuko'], {
    type: 'stdio',
    command,
    args: ['mcp'],
    env: {},
  }, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  });
  const content = applyEdits(source, edits);
  return {
    content,
    action: existing === undefined ? 'created' : content === existing ? 'unchanged' : 'updated',
  };
}
