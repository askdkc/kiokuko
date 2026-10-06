import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { collectInstructionReceipt } = await import(pathToFileURL(path.resolve('scripts/lib/normal-workflow/instruction-receipt.mjs')).href);

function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), 'kiokuko-load-receipt-'));
  const codeHome = path.join(base, 'codex');
  const sessions = path.join(codeHome, 'sessions', '2026', '10', '06'); mkdirSync(sessions, { recursive: true });
  const file = path.join(sessions, 'rollout-test.jsonl');
  const agents = 'Installed unmodified instructions\n';
  const request = 'Explain the shipping threshold.';
  const metadata = { type: 'session_meta', payload: { id: 'test-thread', cwd: base, cli_version: '0.148.0' } };
  const instruction = { type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text: `# AGENTS.md instructions for ${base}\n\n<INSTRUCTIONS>\n${agents}</INSTRUCTIONS>` }] } };
  const prompt = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: request }] } };
  const input = { codeHome, cwd: base, clientVersion: '0.148.0', threadId: 'test-thread', agents, request };
  const write = (records: any[]) => writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return { base, file, agents, input, metadata, instruction, prompt, write, close: () => rmSync(base, { recursive: true, force: true }) };
}

test('loader receipt is derived only from the matching isolated client instruction input before the user request', () => {
  const f = fixture();
  try {
    f.write([f.metadata, f.instruction, f.prompt, { type: 'response_item', payload: { type: 'reasoning', summary: ['PRIVATE_SYNTHETIC_REASONING'] } }]);
    const receipt = collectInstructionReceipt(f.input);
    assert.equal(receipt.observed, true);
    assert.equal(receipt.threadId, 'test-thread');
    assert.match(receipt.contentHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE_SYNTHETIC_REASONING|Installed unmodified instructions/);
  } finally { f.close(); }
});

test('CLI 0.153.4 unscoped instruction header and collaboration reasoning settings are observed without inferring argv',()=>{
  const f=fixture();try {
    const metadata={...f.metadata,payload:{...f.metadata.payload,cli_version:'0.153.4'}};
    const instruction={...f.instruction,payload:{...f.instruction.payload,content:[{type:'input_text',text:`# AGENTS.md instructions\n\n<INSTRUCTIONS>\n${f.agents}</INSTRUCTIONS>`}]}};
    const context={type:'turn_context',payload:{model:'gpt-6-astra',approval_policy:'never',sandbox_policy:{type:'read-only'},
      collaboration_mode:{mode:'default',settings:{model:'gpt-6-astra',reasoning_effort:'ultra'}}}};
    f.write([metadata,instruction,context,f.prompt]);
    const input={...f.input,clientVersion:'0.153.4'},receipt=collectInstructionReceipt(input);
    assert.equal(receipt.observed,true);assert.equal(receipt.effort,'ultra');assert.equal(receipt.model,'gpt-6-astra');assert.equal(receipt.nativeReadonlyObserved,true);
    f.write([metadata,instruction,{...context,payload:{...context.payload,effort:'high'}},f.prompt]);
    assert.equal(collectInstructionReceipt(input).effort,null);
    f.write([metadata,instruction,{...context,payload:{...context.payload,sandbox_policy:{type:'workspace-write'}}},f.prompt]);
    assert.equal(collectInstructionReceipt(input).nativeReadonlyObserved,false);
  }finally{f.close();}
});

test('missing, stale, truncated, late, assistant and tool instructions never prove client loading', () => {
  const f = fixture();
  try {
    assert.equal(collectInstructionReceipt(f.input).observed, false);
    for (const records of [
      [f.metadata, f.prompt],
      [{ ...f.metadata, payload: { ...f.metadata.payload, id: 'another-thread' } }, f.instruction, f.prompt],
      [{ ...f.metadata, payload: { ...f.metadata.payload, cli_version: 'another-version' } }, f.instruction, f.prompt],
      [f.metadata, f.prompt, f.instruction],
      [f.metadata, { ...f.instruction, payload: { ...f.instruction.payload, role: 'assistant' } }, f.prompt],
      [f.metadata, { type: 'response_item', payload: { type: 'function_call_output', output: JSON.stringify(f.instruction) } }, f.prompt],
    ]) { f.write(records); assert.equal(collectInstructionReceipt(f.input).observed, false); }
    f.write([f.metadata, f.instruction, f.prompt]);
    assert.equal(collectInstructionReceipt({ ...f.input, agents: f.agents + 'required extra text' }).observed, false);
    writeFileSync(f.file, JSON.stringify(f.metadata) + '\n' + JSON.stringify(f.instruction));
    assert.equal(collectInstructionReceipt(f.input).observed, false);
  } finally { f.close(); }
});

test('loader collector does not follow session file symlinks or ambiguous duplicate receipts', () => {
  const f = fixture();
  try {
    f.write([f.metadata, f.instruction, f.prompt]);
    const other = path.join(path.dirname(f.file), 'session-duplicate.jsonl');
    symlinkSync(f.file, other);
    assert.equal(collectInstructionReceipt(f.input).observed, false);
    rmSync(other); f.write([f.metadata, f.instruction, f.prompt]);
    writeFileSync(other, [f.metadata, f.instruction, f.prompt].map(record => JSON.stringify(record)).join('\n') + '\n');
    assert.equal(collectInstructionReceipt(f.input).observed, false);
  } finally { f.close(); }
});
