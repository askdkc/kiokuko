import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Inspect only this attempt's newly created CODEX_HOME. Never inspect another
 * client profile or archive raw rollouts (which may include private reasoning).
 * Missing or unfamiliar client records are an unobserved load, not a pass.
 */
export function collectInstructionReceipt({ codeHome, cwd, clientVersion, threadId, agents, request }) {
  const unobserved = { observed: false, reason: 'instruction_load_unobserved' };
  if (!threadId || !agents.trim()) return unobserved;
  try {
    const sessions = path.join(codeHome, 'sessions');
    if (!existsSync(sessions)) return unobserved;
    const files = [];
    let entries = 0, bytes = 0;
    const visit = (directory, depth = 0) => {
      if (depth > 4 || lstatSync(directory).isSymbolicLink()) throw new Error('Session boundary');
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (++entries > 64 || entry.isSymbolicLink()) throw new Error('Session boundary');
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file, depth + 1);
        else if (entry.isFile() && /^(?:rollout|session)-.*\.jsonl$/u.test(entry.name)) {
          bytes += lstatSync(file).size;
          if (bytes > 16 * 1024 * 1024) throw new Error('Session size limit');
          files.push(file);
        }
      }
    };
    visit(sessions);
    const receipts = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (!text.endsWith('\n')) return unobserved;
      const records = text.trim().split('\n').map(line => JSON.parse(line));
      const metadata = records[0];
      if (metadata?.type !== 'session_meta' || metadata.payload?.id !== threadId) continue;
      if (metadata.payload.cli_version !== clientVersion || realpathSync(metadata.payload.cwd) !== realpathSync(cwd)) return unobserved;
      let instructionIndex = -1, promptIndex = -1;
      for (const [index, record] of records.entries()) {
        const item = record.type === 'response_item' ? record.payload : null;
        if (item?.type === 'message' && item.role === 'user') {
          const parts = Array.isArray(item.content) ? item.content.filter(part => part.type === 'input_text').map(part => part.text) : [];
          if (parts.includes(request)) { promptIndex = index; break; }
          for (const part of parts) {
            const match = /^# AGENTS\.md instructions for [^\n]+\n+<INSTRUCTIONS>\n([\s\S]*)\n?<\/INSTRUCTIONS>(?:\n|$)/u.exec(part);
            if (match?.[1].trim() === agents.trim()) instructionIndex = index;
          }
        }
        // A quote in a tool result or model answer cannot prove initial loading.
        if (item?.type === 'function_call' || (item?.type === 'message' && item.role === 'assistant')) break;
      }
      if (instructionIndex < 1 || promptIndex <= instructionIndex) return unobserved;
      const contexts = records.filter(record => record.type === 'turn_context').map(record => record.payload);
      const models = new Set(contexts.map(context => context?.model).filter(model => typeof model === 'string'));
      const efforts = new Set(contexts.map(context => context?.effort).filter(effort => typeof effort === 'string'));
      receipts.push({ model:models.size === 1 ? [...models][0] : null, effort:efforts.size === 1 ? [...efforts][0] : null,
        modelObserved:models.size === 1, clientVersion:metadata.payload.cli_version, observed: true, schema: 'codex-rollout/user-instructions-v1', threadId,
        source: path.relative(codeHome, file), record: instructionIndex,
        contentHash: createHash('sha256').update(agents).digest('hex') });
    }
    return receipts.length === 1 ? receipts[0] : unobserved;
  } catch { return unobserved; }
}
