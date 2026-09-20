# Memory application and execution evidence

Kiokuko tracks whether applicable delivered memory has a current decision and
regression evidence. It cannot prove that a model understood a memory, that a
stated rationale is correct, or that a chosen verifier is sufficient.

## Workflow

1. Read the bundled SOUL and memory-reasoning Skills and call `task_prepare`.
   Complete the existing Akinator intake with `task_answer`.
2. Read `assurance` in the preparation response or call `task_memory_status`.
   It reports the current revision, missing decisions and stale verification.
3. Call `task_memory_review` for selected actionable entries. Bind the run,
   delivery ID, entry ID/revision and expected assurance revision. Choose
   `adopted`, `inapplicable` or `contradicted`. All decisions need current evidence;
   adoption also needs an invariant, counterexample and verifier.
4. For implementation, run the verifier and link its evidence IDs with another
   review. `task_memory_status` with `snapshot: true` returns the pre-execution
   state digest required by `task_execution_evidence`. Public evidence is always
   **model-reported**. The Codex adapter records **client-observed** results only
   when the client supplies a recognized completed exit status.
5. Use `task_memory_refresh` when new paths or errors change the search. Preserve
   the run and exact capability catalog. A different delivery or entry revision
   requires reconfirming affected reviews. Finish with the existing checkpoint.

Only memories selected as actionable require decisions. Incidental retrieval
results do not impose formal checklists. Code PLAN/review requires grounded
application decisions; implementation requires passing regression evidence.
Failure, cancellation and interruption can terminate without passing evidence.
Existing non-terminal server checkpoints remain non-terminal. Legacy callers
without the assurance contract remain unobserved, never retrospectively verified.

Retries use the same `requestId`, complete input and `expectedRevision`. A changed
request under the same ID or a stale revision conflicts. Review and evidence
records are durable. The repository state hash covers Git-visible tracked and
unignored files plus conventional local environment and Codex/Kiokuko config
files; edits invalidate prior results. Other ignored files are outside that snapshot. Symlinks, non-regular files, more than 20,000 files or 64 MiB of content
make snapshot verification unavailable rather than silently incomplete.

## API

The MCP tools and authenticated server routes share the domain implementation:

| MCP tool | POST route under `/api/v1/agent/runs/:runId/` |
| --- | --- |
| `task_memory_review` | `memory-review` |
| `task_execution_evidence` | `execution-evidence` |
| `task_memory_refresh` | `memory-refresh` |
| `task_memory_status` | `memory-status` |

For HTTP, put the request ID in `Idempotency-Key`, the run ID in the path, and
remaining fields in the body. The status body accepts `cwd` and `snapshot`.
`task_inspect` provides bounded preparation reads and bundled Skill access
without executing a model-supplied shell command.

Capability normalization v2 reserves identity space before spending description
space. More than 200 valid capabilities are accepted. Oversized descriptions are
omitted without losing identities. Malformed inputs or identity-budget exhaustion
remain explicitly `unknown`. Digest version 2 conflicts with older bound runs;
start a new logical request after upgrading instead of resuming a v1 binding.

Scoped retrieval distinguishes `no_entries`, `no_match`, `out_of_scope`,
`capability_withheld`, and `delivered` in assurance diagnostics. Search exceptions
remain errors and never become a normal empty result. Counts describe the bounded
search lanes; they are not an inventory of unrelated project memories.

## Codex setup and limits

```sh
kiokuko setup --clients codex
kiokuko doctor
```

Setup adds only Kiokuko-owned event handlers to Codex `hooks.json`; reinstall and
uninstall preserve other handlers and settings. Review the new hook definitions
in Codex `/hooks` and restart/reopen the client as required by its configuration
lifecycle. Configuration presence does not prove that the current client executes
hooks. Doctor distinguishes configured hooks, historical observations and the
unconfirmed current client, plus pending reviews and verification.

The adapter handles UserPromptSubmit, PreToolUse, PostToolUse, Stop, Interrupt and
explicit child lifecycle identities. It derives request bindings from client
hook events, never from a model-supplied session ID. It does not fabricate
`soulRead`. The supported preparation route permits Kiokuko operations and
`task_inspect`; arbitrary shell strings are not classified as read-only.
Unidentified child execution cannot inherit a parent's run. Delegation is denied
on paths where distinct child tool identities cannot be established.

Hooks are not execution isolation. Unsupported tool paths, disabled/untrusted
hooks, adapter startup failures and already running processes remain outside
complete enforcement. In particular, `write_stdin` does not repeat PreToolUse.
Stop cannot retract text already emitted; an incomplete report stops with an
explicit message instead of generating unlimited continuation turns. Interrupt
never requests continuation. Unknown execution result formats stay unknown.
In a local test with **codex-cli 0.153.4**, Bash PostToolUse supplied stdout as
a string (empty for `true`) and no exit-status field. That path cannot produce
observed passing evidence: stdout, JSON printed by a command, and text resembling
an exit header are never trusted as completion metadata. The dedicated live test
therefore fails its required execution-observation check on that client. The
deterministic adapter fixture with structured exit metadata passes; it is not
evidence that the installed CLI or desktop exposes that metadata.
See the [official Codex hook protocol](https://developers.openai.com/ja-JP/docs/hooks).

## Validation

`tests/integration/memory-assurance.test.ts` exercises the next-migration
counterexample, actual migration execution, failed/passing evidence, restart,
stale source and memory revisions, retries, cancellation, atomic refresh failure,
and the shared MCP/server decision path. Historical schema fixtures may retain
fixed versions; current-schema expectations derive from the bundled migration
snapshot in `tests/fixtures/current-migrations.ts`.

```sh
npm run typecheck
npm test
npm run build
npm run test:evaluation
npm run test:sampledb
npm run test:global-install
npm run pack:check
node scripts/run-memory-assurance-live.mjs
```

The dedicated CLI test exits nonzero when the required runtime or observations
are missing. Protocol fixtures, real CLI operation, desktop operation and
model memory-application quality are separate evidence. A CLI pass does not
establish desktop acceptance or a measured improvement in application rate.
