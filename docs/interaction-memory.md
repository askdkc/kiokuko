# Memory from normal interaction

Kiokuko can save durable preferences, facts, decisions, and corrections from normal
conversation. The current client's model extracts concise memories and calls
`memory_capture`; no separate model service or credentials are needed. Each memory
is a revisioned SQLite entry. Automatic saves are **candidate / untrusted**, and
can immediately be recalled as advisory context. A stated evidence basis is not
proof of truth. Curator's reviewed global promotion remains a separate operation.

After updating Kiokuko, run `kiokuko setup` for your selected clients and restart
them so the new tools and bundled instructions load. Existing project work still
uses `task_prepare` / `task_answer`. General conversation uses `memory_recall`
without a repository, task run, or artificial intake answers.

## What is saved

The model is instructed to capture explicit durable preferences and corrections,
settled decisions, verified results, and reusable troubleshooting lessons—even
without “remember this.” It skips routine progress, temporary requests, repetition,
unsupported assistant conclusions, sensitive personal profiling, and transcripts.
Secret detection rejects a whole batch before it writes anything.

Clearly general knowledge can be saved globally with a portability reason.
Project-specific knowledge requires the active project run after intake permits
progress. Uncertain scope stays local or is skipped outside a project. General
communication preferences must be explicitly general; subject preferences retain
their subjects. Memories never authorize actions or override current instructions.

## MCP contract

`memory_capture` is non-terminal. Its input includes `operationId`, optional
`cwd` / `runId`, and one to five `memories`. Each item reuses the checkpoint fields
(kind, title, body, scope, applicability, tags, and portability reason), with:

- `body`: nonempty, at most 2,000 characters; optional summary at most 500.
- `subjects`: one to five labels, normalized to lowercase `subject:` tags.
- `basis`: `user_statement`, `user_correction`, or `observed_result`.
- `generalCommunication: true`: only for an unqualified global preference;
  omit subjects and applicability in this case.
- `replaces: { entryId, expectedRevision }`: only with `user_correction`.
- `reinforces: { entryId, expectedRevision }`: an independently observed project
  lesson, only with `observed_result`. References the existing lesson without
  changing its content, including when the new observation uses different wording.
  Cannot be combined with `replaces`.

For example, a model can extract this from “When explaining Japanese grammar,
I prefer examples before terminology”:

```json
{
  "operationId": "conversation-1-preference-1",
  "memories": [{
    "kind": "preference",
    "title": "Japanese grammar explanations",
    "body": "For Japanese grammar explanations, give examples before terminology.",
    "scope": "global",
    "portableReason": "Applies to Japanese grammar explanations across projects.",
    "subjects": ["Japanese grammar"],
    "basis": "user_statement"
  }]
}
```

Responses contain entry IDs, revisions, workspace, created/duplicate/corrected
outcomes (also `reinforced` for an explicit reference), and
current/changed/superseded/unavailable availability. Reuse an
operation ID only for an exact retry; a different payload conflicts. Exact
normalized content across separate operations deduplicates independently of
timestamps, client provenance, and run IDs. Similar paraphrases are not merged.

Corrections require an exact current revision in the same scope. Creating the
replacement and superseding the old entry is atomic, including for a previously
verified entry. History remains accessible through existing review controls.
Stale revisions, duplicate correction targets, and managed entries are rejected.
Operation receipts contain no memory text. Retrying a purged operation acknowledges
its unavailable entry without recreating it. A new operation ID is a new request,
not a deletion tombstone bypass prevention mechanism.

`memory_recall` takes `soulRead: true`, the complete current capability catalog,
`query`, optional `subjects`, `limit` (default 8, maximum 20), and
`maxContextChars` (default 4,000, range 100–12,000). Read the exact local
`kiokuko-soul` and `memory-reasoning` Skills before advertising them. Missing SOUL
blocks recall; missing or unknown memory-reasoning withholds ordinary memories.
Current managed Curator projections retain the existing trusted-memory exception.

Recall searches only global memory, using lexical and optional semantic retrieval.
Explicit subjects restrict matching before result selection. Without explicit
subjects, at most two general communication preferences may appear without query
word overlap. Subject preferences require the subject in the query or an explicit
subject filter. Prefer query-only recall. Pass explicit filters only for exact known stored labels,
not guessed synonyms. Use short topic labels at capture time. Project preparation
uses the same preference selection within its existing budget and capability gate.
Returned records include IDs, revisions, subjects, status/trust labels, and concise
content. The character budget includes the serialized memory items, not protocol
or capability metadata.

Save important corrections promptly; batch other captures before the final answer.
Do not resubmit captured memories in `memory_checkpoint`, which remains terminal.

## Automatic priority promotion for repeated lessons

When the same project lesson is reported as `observed_result` in two independent
root task runs, its retrieval priority becomes **reinforced** automatically.
Captures return `reinforcement: { independentRuns, priority, promoted }` describing
the observation at that operation. An exact retry returns that historical receipt;
`availability` separately describes the current entry revision. A new operation
reports the updated observation count. This does not change `candidate` status,
trust, confidence, or content, and never grants global verification.

The identity is normalized lesson body plus project workspace and applicability.
Titles, subjects and transport provenance do not add independent observations.
Different wording requires an explicit `reinforces` reference; similarity alone
does not merge lessons. Each root run counts once, including child runs, repeated
operations and transport retries. Different run IDs are independent request
identities, not proof that the model really observed another failure.

`memory_checkpoint` also contributes when it supplies a project lesson **and**
a passed/failed command or test result. Evidence-only checkpoints create no
lesson or observation. Declarations without execution evidence do not count.
These are model-reported observations, not client-observed verification.

Matching reinforced lessons precede ordinary results before lexical candidate
limits and project context budgets. Delivered items carry `repeated_lesson` and
require an applicability decision through memory assurance. Adoption in an
implementation task requires passing regression evidence before a successful
terminal checkpoint; a grounded inapplicable/contradicted decision remains valid.
The normal workspace, query, subject, capability and context-budget boundaries
still apply. This cannot recover a lesson that was never captured, force an
unrelated search hit, or guarantee compliance from clients without enforcement.

Migration `005_lesson_reinforcement.sql` adds observation history without
backfilling or promoting existing entries. Revision changes, corrections and
purges remove the affected observations. Observations and entry/receipt writes
commit atomically. Workspace exports do not export local observation counts;
imported memories require new observations. Upgrade the installed package and
restart its MCP server to activate the implementation; update managed client
instructions with `kiokuko setup` / `kiokuko use` as appropriate.

## Disable capture

Set the environment variable on the Kiokuko MCP server process, then restart it:

```bash
KIOKUKO_INTERACTION_MEMORY=off kiokuko mcp
```

In a client's MCP configuration, put `KIOKUKO_INTERACTION_MEMORY = "off"` in its
server environment rather than starting a second server manually. Recall and
existing explicit checkpoints remain available. No new management UI is needed:
use the existing Web/CLI review, history, and deletion controls.

## Storage and limits

Migration `003_interaction_memory.sql` adds an indexed fingerprint projection.
Revision hashes keep their original provenance-sensitive definition. Candidate
edits, imports, superseding, purge, and search-index rebuilding maintain the
projection. Existing memories are not automatically reclassified. Receipts are
local operational metadata; workspace exports include memories, not retry history.

One database represents one user. Capture is model-mediated and cannot intercept
every turn. SQLite capacity is not a promise of unlimited project retrieval: the
existing 10,000-entry project snapshot integrity limit remains in force.

See [interaction memory validation](interaction-memory-validation.md) for automated
checks, performance measurements, and separate live-client results.
