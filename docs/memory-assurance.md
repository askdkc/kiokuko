# Memory application and execution evidence

Kiokuko tracks whether applicable delivered memory has a current decision and
regression evidence. It cannot prove that a model understood a memory, that a
stated rationale is correct, or that a chosen verifier is sufficient.

## Workflow

1. Read the bundled SOUL and memory-reasoning Skills and call `task_prepare`.
   Complete the existing Akinator intake with `task_answer`.
2. Read `assurance` in the preparation response or call `task_memory_status`.
   It reports the current revision, missing decisions and stale verification.
   `nextAction=review_memory_application` requires decisions before ordinary
   tools or code search; `refresh_memory` requires refreshing the same run first.
   Use `task_inspect` for evidence and bundled Skills while these gates are open.
3. Call `task_memory_review` for selected actionable entries. Bind the run,
   delivery ID, entry ID/revision and expected assurance revision. Choose
   `adopted`, `inapplicable` or `contradicted`. All decisions need current evidence;
   adoption also needs an invariant, counterexample and verifier.
   Submit decisions sequentially using the latest returned revision, then check
   `task_memory_status`. Its `nextAction=proceed` permits implementation and tests;
   missing verification still prevents completion. Do not repeat `task_prepare`.
4. For implementation, run the verifier and link its evidence IDs with another
   review. `task_memory_status` with `snapshot: true` returns the pre-execution
   state digest required by `task_execution_evidence`. Public evidence is always
   **model-reported**. The Codex adapter records **client-observed** results only
   when the client supplies a recognized completed exit status.
5. Use `task_memory_refresh` when new paths or errors change the search. Preserve
   the run and exact capability catalog. A delivery ID or query change alone preserves compatible decisions. Changed
   entry revisions or decision dependencies require reconfirming affected reviews. Finish with the existing checkpoint.

Only memories with explicit applicability, target path/error matches or a
repeated lesson require decisions. Word/tag matches and helpful feedback remain
advisory. Adopting an advisory candidate explicitly still requires a review.
General communication preferences do not create code verification requirements. Code PLAN/review requires grounded
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

## Decision and observation storage

Migration 011 preserves existing history without certifying legacy decisions,
clearing stopped runs or converting unknown evidence. New decisions are immutable
run-scoped records linked from deliveries. Status exposes decision IDs, original
delivery IDs, invalidation codes, `observationSequence`, and the loaded integration
contract. The latest decision is checked first; an older matching assessment is
never resurrected after a newer one changes the conclusion.

A decision defaults to the whole repository state digest. An optional
`dependencies: { paths: ["src/file.ts"], errors: ["explicit error"] }` records only
those path conditions plus the listed error conditions. No dependencies are
inferred from prose. Run, root, task profile, scope, policy and entry revision must
also match. General communication preferences exclude code state by default.
Evidence retains its original provenance and delivery. Reuse additionally checks
run, root, source digest, exit status and the attached verification definitions.

New execution observations increment their own sequence. Unchanged reads add no
review revision and request no evidence association. A target-state transition
increments the review revision once even if multiple completions observe it.
Unknown/raw output results never satisfy a verification check. Public
`task_execution_evidence` stays model-reported and does not advance review
revision merely by adding an observation.

## API

### Task completion (verification contract v1)

Newly enrolled build/debug runs and runs with observed source changes require
task checks independently of delivered memory. `complete` still describes only
memory application. `completionReady` combines that decision with all required
task checks. It is `null` for historical runs, which remain unobserved; migration
does not retroactively certify them. PLAN/review without source changes need no
implementation checks.

Before implementation, call `task_verification_define` with the usual `cwd`,
`runId`, new `requestId`, current `expectedRevision`, a nonempty `reason`, and
`checks: [{ id, target, expected, method }]`. Every check is required. Target
labels distinguish environments such as `linux-x64` and `darwin-arm64`.
Each new definition has a contract version. Unchanged checks retain results;
changed, removed/reintroduced checks require new results. Definition history is
retained, including the reason for a scope change; do not remove failed checks
merely to make completion pass.

`task_verification_record` accepts the same operation identity fields plus
`contractVersion`, `checkId`, `target`, and either:

- `source: { kind: "local", evidenceId }`: an execution evidence record from
  this run, target and current source digest. `task_execution_evidence.target`
  defaults to the host's platform/architecture; specify the actual remote or
  container target when reporting its execution. Hook observations always use
  the host target.
- `source: { kind: "ci", commit, runUrl, jobUrl, conclusion }`: an HTTPS run/job
  reference without credentials or query parameters, the exact current clean
  commit, and `success`, `failure`, `cancelled`, `timed_out`, `skipped` or `unknown`.
  These are model-reported assertions, not independently fetched CI results.

Status returns `verification` with the contract version and each check's
`pending`, `passed`, `failed`, `skipped` or `unknown` status, staleness and
provenance. Only current passing results satisfy required checks. Later failure
or unknown results replace earlier successes. Source changes invalidate results;
CI checks also require the same clean HEAD. A null child exit status does not
establish either success or the cause of termination.

MCP completed checkpoints, the Agent close API and Codex Stop share this gate.
Failure, cancellation and interruption remain valid terminal outcomes. The
gate checks the consistency and presence of declared evidence; it does not prove
that a model chose sufficient checks or interpreted external logs correctly.

The HTTP equivalents are `verification-define` and `verification-record` under
the same authenticated run route. As for other assurance mutations, use
`Idempotency-Key` for requestId and the URL for runId. The global-only ChatGPT
memory connector does not expose project-task tools.

### Refresh conflicts and one bounded recovery

Typed conflicts expose fixed `reason`, `nextAction`, `recoverable`,
`maxRecoveryAttempts` and `retryable` fields consistently through MCP and HTTP.
Revision values are included only after matching the run/repository binding.
Raw exceptions, filesystem paths, capability catalogs and memory bodies are not
diagnostic payloads. Revision mismatch and retrieval-state changes are
recoverable; request identity reuse, binding mismatch, an inactive run and
missing required capabilities are not automatic-recovery cases.

`retryable: false` means that an unchanged failed request must not be resent.
For a typed recoverable conflict, the agent may read `task_memory_status` and
submit one new requestId using the current revision, same run and bound catalog.
Review a new delivery before continuing. This is a bounded agent workflow, not
an internal server retry loop. A second conflict or unknown failure must be
reported with the unfinished work. A denial stops the turn
for authorization or identity violations and cannot be bypassed by this workflow.
Preparation, intake, pending review and stale delivery denials are recoverable
and permit repair in the same turn. Skill reads and execution observation
sequence increments do not advance the review revision; target changes do.

After updating the package, refresh managed instructions through setup and
reconnect the MCP client. Check the connected tools and exercise
status → skill read → refresh against that runtime. Source tests and generated
configuration alone do not prove the desktop connection has reloaded.

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

Start preparation with `{"cwd":"/absolute/repository","operation":"skill"}`;
omitting `path` reads `kiokuko-soul`. Other bundled Skills accept their name
(for example, `memory-reasoning`) or `skill-name/SKILL.md`; references use
`skill-name/references/file.md`. Skill access is independent of Git and reads
the package's bundled files, rather than installed client paths. Repository
reads accept relative paths or absolute paths inside the repository. Rejected
paths return fixed recovery guidance without exposing filesystem details.

Fresh clones do not need `git submodule update --init --recursive` for preparation
or hook snapshots. Missing or empty uninitialized submodules are recorded with
their indexed commit and initialization state. Initialized submodules are
inspected recursively, so initializing them or changing nested files invalidates
earlier evidence. A nonempty submodule directory without Git metadata is rejected
because its contents cannot be verified by a Git snapshot.

Capability normalization v2 reserves identity space before spending description
space. More than 200 valid capabilities are accepted. Oversized descriptions are
omitted without losing identities. Preparation rejects malformed catalogs or
identity-budget exhaustion before creating a run; correct them under the same
logical request ID when `runCreated=false`. A successfully bound catalog remains
fixed. Legacy recovery requires validation against the stored catalog digest;
an incompatible digest version cannot be silently replaced.

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

Codex deploys host-specific names such as `kiokuko-codex-soul` and
`kiokuko-codex-memory-reasoning` under `.agents/skills`. Legacy shared paths are
retained, including DSH-owned files with matching old markers. Each deployed file
has an owner, host, contract ID/version and content hash. Updates and removal
require matching ownership and the previous hash; edits and foreign files cause
an update conflict. Setup planning and commit rollback cover these deployments.
Only names in the bundled manifest are mapped to logical capabilities.

MCP assurance/status and bundled Skill inspection expose the loaded contract;
inspection also returns package version and content hash. Hook diagnostics expose
the observed hook version and exit-metadata capability. Preparation from a
mismatched MCP contract remains blocked with diagnosis available. These describe
different surfaces: configured/deployed files, loaded MCP and observed hooks.
Matching hashes do not prove the model read or applied a Skill.

The adapter handles UserPromptSubmit, PreToolUse, PostToolUse, Stop, Interrupt and
explicit child lifecycle identities. It derives request bindings from client
hook events, never from a model-supplied session ID. It does not fabricate
`soulRead`. The supported preparation route permits Kiokuko operations and
`task_inspect`; arbitrary shell strings are not classified as read-only.
Unidentified child execution cannot inherit a parent's run. Delegation is denied
on paths where distinct child tool identities cannot be established.

Preparation/intake and pending/stale review denials block only the attempted
call. They return fixed reason codes, `recoverable: true` and the required next
operation. They neither set `stop_notified` nor fail the run. Complete preparation,
status, refresh and review using the same client request, agent, repository and
run binding; ordinary execution becomes available in the same turn.

Authorization/identity violations and conflicting call-ID reuse remain terminal.
The durable `stop_notified` latch is set before returning that denial and the bound
active/intake run fails. Interrupted and terminal runs cannot be reopened by
preparation, recovery or a delayed completion. Hook restarts do not clear existing
latches. Child preparation is independent; a child's missing preparation cannot
fail its parent run.

Before a denial, the exact user clarification tools `request_user_input` and
`request_user_input_async`, and the observed time-read tool `clockcurr_time`,
remain usable during preparation and pending memory reviews. This permits asking
an intake question or checking the time without granting shell, file, network
or other execution access. These calls do not produce execution evidence.
Once a turn is stopped, they are denied too. Other clock tools, such as sleep,
are not exempted.

Pending-memory blocks show pending/stale counts and the required ordering of
`task_memory_status` and `task_memory_review` with the latest returned revision;
reusing an old `expectedRevision` produces a conflict. Allowed tool calls stay
quiet. Preparation, review and refresh completions proactively report the current
next step before another ordinary tool is attempted. The initial prompt directs
all preparation Skill reads, including `natural-japanese-output`, through
`task_inspect`; no shell read is needed to bootstrap. Diagnostics never echo tool
arguments or command output. Existing hook
history is not rewritten; the new messages require the updated Kiokuko executable.

Hooks are not execution isolation. Unsupported tool paths, disabled/untrusted
hooks, adapter startup failures and already running processes remain outside
complete enforcement. In particular, `write_stdin` does not repeat PreToolUse.
`PreToolUse` does not support `continue: false` or `stopReason`; returning those
fields can fail the hook and let the tool execute. The adapter therefore uses
the supported deny response, and a durable latch for terminal violations, with stop output only on events
that support it. This prevents further supported tool admissions; it cannot
guarantee that Codex immediately stops generating text or trying denied calls.
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

To exercise only the denial/stop path with an installed Codex CLI, run
`node scripts/run-memory-assurance-live.mjs --hard-stop-only` after building.
The full live check uses a separate fresh client request for a recoverable
unprepared denial followed by preparation and execution in that same turn.

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

Explicit memory maintenance may use `task_memory_refresh.indexing` after intake.
`memory_index_submit` and `memory_index_review` bind the resulting immutable work
batch to that run, delivery and assurance revision. See [memory indexing](memory-index.md)
for quote validation, modes, budgets, HTTP routes and evaluation.
