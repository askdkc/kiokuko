import type { SqliteDatabase } from '../db/adapter.js';
import { withDeferredReadTransaction } from '../db/transaction.js';
import { isCuratorManagedGlobalMemory } from './curator-trust.js';
import { globalLaneCandidates } from './federated-retrieval.js';
import type { HybridSearchRuntime } from './hybrid-retrieval.js';
import { memorySubjects } from './interaction-subjects.js';

interface GlobalConversationQuery {
  readonly query: string;
  readonly limit: number;
  readonly maxContextChars: number;
  readonly subjects?: readonly string[] | undefined;
}

/** Internal read service. Each caller must enforce its own client policy first. */
export function queryGlobalConversationMemory(
  database: SqliteDatabase,
  input: GlobalConversationQuery,
  runtime: HybridSearchRuntime = {},
  withholdOrdinary = false,
) {
  return withDeferredReadTransaction(database, () => {
    const result = globalLaneCandidates(database, input.query, input.limit, runtime, input.subjects);
    const items: Array<{ entryId: string; revision: number; kind: string; status: string; trustLevel: string;
      title: string; content: string; subjects: string[]; metadata: { storedData: true; untrusted: true; instructions: false } }> = [];
    let characters = 2;
    let truncated = result.truncated;
    for (const { entry } of result.candidates) {
      const content = entry.summary ?? entry.body;
      if (withholdOrdinary && !isCuratorManagedGlobalMemory(entry)) continue;
      const item = { entryId: entry.id, revision: entry.revision, kind: entry.kind, status: entry.status,
        trustLevel: entry.trustLevel, title: entry.title, content: '', subjects: memorySubjects(entry),
        metadata: { storedData: true as const, untrusted: true as const, instructions: false as const } };
      const overhead = Array.from(JSON.stringify(item)).length + (items.length ? 1 : 0);
      const remaining = input.maxContextChars - characters - overhead;
      if (remaining <= 0) { truncated = true; break; }
      // Find the longest prefix whose JSON escapes also fit the complete item budget.
      const codepoints = Array.from(content);
      let low = 0, high = Math.min(codepoints.length, remaining);
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        item.content = codepoints.slice(0, middle).join('');
        const size = Array.from(JSON.stringify(item)).length + characters + (items.length ? 1 : 0);
        if (size <= input.maxContextChars) low = middle;
        else high = middle - 1;
      }
      item.content = codepoints.slice(0, low).join('');
      if (item.content !== content) truncated = true;
      characters += Array.from(JSON.stringify(item)).length + (items.length ? 1 : 0);
      items.push(item);
    }
    return { items, characterCount: items.length ? characters : 0, truncated };
  });
}
