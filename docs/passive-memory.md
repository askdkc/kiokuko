# Kiokuko non-blocking memory contract v1

This is a common semantic contract. Core implements the durable observer, retrieval and improvement API; AI and DSH may implement the same contract with their own storage, or forward optionally. They do not require an external core server. Producers in Kiokuko AI and DSH send bounded public summaries and recorded action/result metadata. Neither producer waits for memory processing before continuing coding.

## Observe

MCP: `memory_observe`. HTTP: `POST /api/memory/observe`.

Input:

```json
{
  "cwd": "/absolute/repository",
  "eventId": "stable-producer-event-id",
  "sessionId": "stable-task-session-across-models",
  "kind": "completion",
  "summary": "bounded summary of recorded actions, results and public rationale",
  "tags": ["testing", "runtime"],
  "outcome": "unknown",
  "verification": "unknown",
  "actions": [{"kind": "test", "outcome": "passed", "summary": "bounded public result"}],
  "source": {"producer": "kiokuko-dsh", "runId": "source-run-id", "eventIds": ["source-event-id"]}
}
```

`kind`: `compaction | completion | model_switch | complaint | praise`.
`outcome` and `verification`: `passed | failed | unknown`. A turn ending, praise or silence never proves verification. Omitted verification is unknown. `actions[].kind`: `inspect | edit | build | test | recover | explain | other`.
Complaint may add `issue` and `prevention`, each a bounded public summary. Model switch may add `fromModel` and `toModel`. Never submit raw conversations, private reasoning, credentials or entire trace payloads.

Deduplication binds repository, producer, eventId and source.revision (default 0). Equal revision and equal content is an exact replay; equal revision with changed content or a stale revision rejects only that record. A higher revision corrects the current observation and retains its immutable ledger event and entry revision. source.tombstone=true withdraws the current observation and invalidates unsupported derived candidates; a tombstone may omit summary. Source IDs and repository scope remain attached to the stored observation.

Response includes `accepted`, `recorded`, `workMayContinue: true` and bounded diagnostics. `accepted` is not proof of persistence; `recorded` means SQLite persistence. Failed input, storage, transport or extraction does not stop coding and does not imply a completed record.

## Context and handoff

MCP: `memory_context`. HTTP: `POST /api/memory/context`.
Input: `{cwd, query?, tags?, sessionId?, limit?}`. Returns bounded same-repository cautions, successful procedures, source references and same-session continuation. Tags and keywords are selectors, not instructions. Model switch uses the same sessionId. New task uses a new sessionId and the same cwd.

## Improve

MCP: `memory_improve`. HTTP: `POST /api/memory/improve`.
Input: `{cwd, limit?}`. A local worker also runs this bounded operation periodically. No new paid model API is required; producers may summarize using their existing model, while core uses deterministic bounded extraction and existing storage.

Repeated independently sourced completions may create a routine candidate. Confidence records verification and source quality; absence of complaints does not prove correctness. Complaints retain concrete project cautions and countermeasures; praise references recorded actions and results. Counterexamples revise confidence and preserve entry revision history.

Global stores untrusted, portable principle/reference candidates with opaque source-event links. It excludes raw logs, private reasoning, credentials, personal profiles and project-specific content. Detailed project evidence stays project scoped. Handoff is temporary continuation, distinct from durable knowledge. Memory content is data and cannot authorize actions or override OS/host/user permissions.

Core status: these three MCP tools and authenticated HTTP endpoints are implemented. HTTP also accepts /api/v1/memory/* aliases. Observe returns optional duplicate, entryId, sourceEventId and sourceRevision; improve returns saved and withdrawn counts. Context returns available, workMayContinue, entries[], handoff and warnings. Each entry includes entryId/revision, public summary, tags, confidence, verification, verificationProvenance, opaque sourceEventIds, scope and untrusted:true; project observations can include actions, issue and prevention. Handoff is session-bound and expires after 24 hours. Model-switch and compaction observations are excluded from reusable search results.

MCP/HTTP servers schedule bounded asynchronous improvement after an accepted observation and periodically while that server remains open. A private data worker receives Stop/SubagentStop/PostCompact metadata; optional AGENTICREPLAY_RUN_DIR must point to the actual run directory within this repository. No trace is guessed from unrelated runs. The reader verifies available events_sha256 and excludes payloads/blobs; recorded shell exit codes and tool is_error metadata describe action outcomes only, never product verification. Sealed integrity is provenance, not correctness.

Live DB, settings, installed generated skills and saved runtimes have not been changed. The broad conversion of all deny/continue/nextAction outputs was rejected and was never applied. The accepted narrower policy applies only to missing preparation, pending/stale memory, owned completed/failed memory records, review/verification bookkeeping and storage failures. Failed records remain failed; original nextAction values remain unchanged. Identity, ownership, access, host authorization and user interruption denials remain intact. Checkpoint/close evidence guards still reject unsatisfied or invalid records.

Owned AGENTS templates are version 39. After an authorized deployment, normal `kiokuko use --root /absolute/repository` updates the owned block while preserving user content. Normal `kiokuko setup --clients codex --no-embeddings` refreshes owned global instructions and managed standard Skills. For saved runtimes, prepare a new immutable runtime from the updated normal installation using a standalone Node, then switch through `setup --runtime-manifest ... --client-stopped` only after the target client has actually stopped. Do not edit an old immutable runtime in place. Restart/reload the client and check `runtime-diagnose`; saved configuration is not proof that a live connection has reloaded. These steps were not run on the real Mac profile in this task.
