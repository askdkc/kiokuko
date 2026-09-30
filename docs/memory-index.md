# Atomic facts and bridging facts

Memory indexing is optional, project-only precomputation by the connected AI.
Kiokuko does not generate claims or add a generation provider. Original entries
and embeddings remain unchanged. Existing lesson derivation is a separate feature.

## Enable maintenance

```sh
kiokuko memory-index status --cwd /absolute/repository
kiokuko memory-index mode observe --cwd /absolute/repository
kiokuko memory-index rebuild --dry-run --cwd /absolute/repository
kiokuko memory-index rebuild --cwd /absolute/repository
```

The default is `off`. Saving an eligible original revision only queues work.
Rebuild invalidates existing outputs and queues current originals; dry-run changes
nothing. `observe` runs the existing hybrid/RRF search with generated candidates
in a shadow pass and reports ranks, references and elapsed time; ordinary context
items are identical to `off`. `active` permits reviewed bodies in project context.
Global memory, preferences, imported Skill documents, derived lessons and other
index artifacts cannot be generation sources. Changing a mode invalidates replay.

## Connected AI workflow

Start an explicit maintenance task through the normal SOUL/capability and Akinator
intake. Do not force generation during ordinary tasks. After intake completes:

1. Call `task_memory_refresh` on the same run and catalog, with a new `requestId`,
   current assurance `expectedRevision` and `indexing: {"stage":"atomic"}`.
2. Read `context.items` and `indexing`. Sources are complete, at most five. The
   response includes retained `atomicFacts` and `atomicSlots` for partial work
   recovery; avoid regenerating already supported statements. Retained outputs are
   untrusted reference aids; derive and review new claims only against originals. It binds a `workId`, source revisions/hashes, template and 30-minute
   expiry. Retained fact text shares the character budget; `omittedAtomicFacts`
   lists references that did not fit. `unprocessed` explicitly lists omitted whole sources; `nextCursor`
   advances the bounded scan. Retry omitted sources with a sufficient context
   budget in a newly prepared task; do not slice or normalize their bodies.
3. Call `memory_index_submit` with `cwd`, `runId`, `deliveryId`, `workId`, current
   assurance `expectedRevision`, a unique `operationId` and `units`:

```json
{
  "type": "atomic",
  "title": "Database engine",
  "text": "Kiokuko uses SQLite.",
  "sourceIds": ["SOURCE_ID"],
  "entities": [{"kind":"package","namespace":"database","name":"SQLite"}],
  "quotes": [{"entryId":"SOURCE_ID","start":0,"end":20,"text":"Kiokuko uses SQLite."}]
}
```

   This illustrates one unit; compute the actual `start` and `end` from the
   delivered saved text. JavaScript UTF-16 offsets, including surrogate pairs,
   are required. Quotes must match `source.body.slice(start,end)` exactly.
   There are at most eight atomic units per current original revision (supported and live pending outputs), forty per submit.
4. Independently compare each candidate against all quoted source claims. Call
   `memory_index_review` with the same bindings, a fresh operation ID, returned
   `entryId`/`entryRevision`, `verdict` (`supported`, `unsupported`, `uncertain`)
   and nonempty `basis`. Only `supported` becomes search-eligible. This is a
   model-reported assessment, **not factual verification or trust promotion**.
5. Refresh with `indexing: {"stage":"bridge"}`. Supported atomic entities are
   included for only this source batch. Submit a bridge with exactly two original
   source IDs, exact quotes from both, a qualified shared entity, and `connection`
   explaining their complementary relationship. Match applicability exactly;
   known contradiction links forbid the pair. Entity namespaces and case are
   significant; ambiguous aliases are never automatically merged. Review it.

Identical operation retries return the saved result. Changed input under an ID,
wrong delivery/run, changed sources, stale assurance or expired work conflicts.
An interrupted unreviewed source remains queued for a later fresh batch. Batch
expiry does not revoke supported knowledge; source revision and integrity do.

HTTP uses the same services at authenticated POST routes under
`/api/v1/agent/runs/:runId/`: `memory-refresh`, `memory-index-submit`,
`memory-index-review`. Put the refresh request/submit/review operation ID in
`Idempotency-Key`, run ID in the path, and other fields in the JSON body. Neither
identity may also appear in the body. Codex hooks recognize both maintenance
mutations; hook observation remains subject to the client's existing limits.

## Delivery, deletion and recovery

Active project context includes `knowledgeType`, source revision/hash references
and exact quote text appended to the body. Citation text counts toward the
Unicode character budget. Initial limits are three bridges, 30% for bridges and
50% for all generated knowledge; preference/repeated-lesson priority is preserved.
The active search retains a separate original-only candidate pass and bounds
generated candidates to half the requested search limit (at least one), so
generated top-k cannot erase the original pool. An original and its atomic fact compete by existing ranked order. A bridge and
its sources remain separate evidence. Generated bodies are never silently sliced.

Source updates and supersedes invalidate outputs immediately; retrieval checks
all source references again. Purging a source deletes affected work and outputs,
quotes/entities, search projections, embeddings/jobs and operation receipts.
A work batch is indivisible: other outputs from that same purged-source batch
are removed too. Late submit, review and embedding completion cannot recreate it.
Corrupt generated metadata and invalid generated vectors are excluded; ordinary
memory retains its existing integrity behavior. Managed outputs reject ordinary
editing, promotion, superseding and Curator globalizing.

JSONL v2 export/import containing index outputs is rejected. Use a complete
SQLite backup (`kiokuko backup`) for backup/restore. Rebuild can recreate outputs
from surviving originals through another explicit AI maintenance task.

## Evaluation and activation

`npm run test:memory-index:evaluation` runs the fixed Japanese/English cases and
prints four variants: current retrieval, atomic-only, atomic + bridge, and bridge
retrieval with its body withheld from the answer context. It reports deterministic
evidence coverage/Recall/MRR, latency and storage/generation counts. CI runs this
suite and the lifecycle/quote/budget tests. These checks do not measure a model's
answer accuracy or prove a real-world performance improvement.

For an answer evaluation, use each printed context with the same pinned answer
model, settings and budget. Record answer correctness, source consistency,
unsupported assertions and single-source regressions in the result form in `tests/fixtures/memory-index/answer-review.json`. Keep `observe` until two-hop answers improve, safety tests pass and
single-source cases do not regress; only then switch that workspace to `active`.
If improvement is absent, keep it disabled. No workspace is automatically enabled.

From a source checkout, `node scripts/run-memory-index-answer-evaluation.mjs`
prepares 32 answer prompts without invoking a model. Add `--run` to execute
fresh answer-only Codex sessions using the existing login, identical settings,
read-only empty directories, and disabled tools/memory/plugins. The runner rejects
observed tool calls and a changed or unknown model identity. Answer keys are
scoring data and are never sent to the answer model or retrieval ranking. The
result file leaves correctness fields null until reviewed. This is an explicit
model evaluation, consumes the account's normal model allowance, and is not a CI
test or an internal Kiokuko generation service.

The exploratory connected-model results are in
`tests/fixtures/memory-index/answer-review-results-2026-09-30.json`. All four
variants supported the same answers on the eight small cases. The answering
assistant had already seen the answer key and reviewed its own answers, so these
results are **not a blind accuracy estimate** and demonstrate no quality uplift.
The current set already gives baseline retrieval complete evidence and uses
atomic copies of short originals; it cannot establish compression or difficult
retrieval benefits. An explicitly requested workspace trial may exercise active
delivery, but must not be reported as evidence that active improves accuracy.
