# User-reviewed experience memory

Recorded experience is optional assistance. It never grants tool authority, substitutes for actual task verification, or blocks ordinary authorized execution. Native sandbox and explicit human interruption still apply.

This document covers the evidence-backed AgenticReplay maintenance path. Ordinary
ChatGPT/Codex sessions use `memory_capture`: after the model organizes a bounded
proposal, native elicitation displays that exact proposal and digest and asks save or
decline. It does not require an AgenticReplay trace.

The automatic review flow uses the native MCP client question UI described below. It never launches a terminal approval flow or suggests terminal input as an authorization fallback.

For standalone manual maintenance after a task is actually complete, a person may run:

    kiokuko memory-review --cwd /repository --trace /repository/.agenticreplay/runs/RUN --task TASK --session SESSION

The interactive terminal first asks whether the task is complete, then proactively organizes the selected replay without a separate permission question. It resolves bounded inline payloads and SHA-256-validated blobs, excludes model reasoning and system messages, redacts detected secret-bearing fields, and presents the exact proposed JSON and digest. This is a whole-run review; task/session labels are human supplied and are not proof every event belongs to that task. Commands, result references, exit metadata, inferred languages and uncertainty remain visible.

Approve saves the exact displayed revision transactionally. A comment replaces proposed key points, attributes them to the user, increments the revision and shows a fresh preview. Decline, interrupt, restart, missing input, extraction failure and obsolete question responses save nothing. There is no model-facing approval flag or auto-save. This standalone CLI checks terminal interactivity only. A PTY is not authenticated human origin: an agent or other process controlling that terminal can type the same answers. It must not be exposed as the model-facing or automatic approval path, and model-controlled terminal answers must never be treated as user consent.

Approved memories and tag/keyword terms share one transaction with the existing entry search index. An exact approval identity supports read-only reconciliation after an uncertain commit; the host does not automatically retry the write. Retrieval stays repository-scoped, uses the existing hybrid search, and carries evidence references. Tool success alone is not task success. Legacy passive records are not treated as newly approved memories.

## History-informed decisions

- 892dfa6 changed review responses and status reads to preserve revision/cursor snapshots; stale/replayed answers must remain memory-side validation, not an ordinary-tool gate.
- c55350c introduced asynchronous observation and benign bookkeeping failure. Its prior tests expected automatic passive entries and global principle derivation. The new design preserves nonblocking behavior but removes those writers because a lifecycle event is not human permission to save.
- a271f0e improved missing-binding diagnosis. Preserve honest unavailable/unknown diagnostics, rather than silently reporting memory or verification success.
- Existing record validation, repository scoping, secret checks, causal evidence and SQLite transactions remain useful. The memory-review completeness condition is removed from product completion; actual product verification remains independent.

These are source/diff findings, not proof that any historical incident had a single cause. Local verification and platform/CI limitations are reported separately.

## Native MCP client questions

A client advertising MCP elicitation can use `memory_review_completed` on an already completed, repository-bound run. The server organizes an ephemeral proposal and asks the client UI only for exact-candidate save approval. Tool arguments contain no approval boolean. When `AGENTICREPLAY_RUN_DIR` is explicitly configured, completed operational checkpoints queue this optional flow without awaiting human input in the task/database call. Client decline/cancel and unsupported elicitation cannot save. SDK protocol tests are distinct from verification in any particular desktop UI.

The native replay dialog asks only whether to save this experience and shows a
plain-language summary of at most six short lines. Internal session/run IDs,
revision numbers, hashes, search terms, raw tool output and correction fields are
not displayed. IDs embedded in extracted key points are omitted from the preview
as well. Long summaries are shortened with an ellipsis; the original request,
key points and linked tool evidence remain unchanged in the approved proposal.
Use the client's Approve or Decline button. Decline or cancel saves nothing.
Unexpected form values cannot approve or revise the proposal. The standalone CLI
continues to support explicit corrections and fresh review.

A genuinely settled failed task may also be reviewed; its summary says the task failed and the proposal records that outcome. Interrupted/cancelled tasks and explicit Stop do not start review. Repeated exact source/content approvals deduplicate independently of presentation IDs. Approved mirror retrieval checks the indexed entry revision and status. Confirmed purge deletes the mirror and search terms and retires old approval receipts, so retry cannot resurrect purged material.

After an approved save reports an uncertain result, the host retains that exact candidate and approval key in process and performs read-only reconciliation. Only an independently visible matching committed receipt can report saved. It does not generate a new approval key or blindly retry writes. Restart loses this ephemeral recovery context; an unverified prior save remains unknown rather than being claimed successful.

## Codex desktop turns

On macOS, enable recording for Git projects added in Codex. Setup can run from
any directory:

    kiokuko setup --clients codex --codex-dock-record

This requires an installed AgenticReplay version that supports `codex-service`.
Setup reads the selected profile's added-project list, checks each live Git
worktree through the existing `.kiokuko.json` and managed instruction flow, and
registers those worktrees. Deleted projects and non-Git folders are ignored;
duplicate paths resolve to one canonical worktree. When the profile has no saved
projects, explicit setup from a Git worktree remains supported.
Quit Codex completely and reopen it from the Dock once after registration.
The existing SessionStart/UserPromptSubmit hooks register a newly added project
when it is first used, while recording is enabled. They preserve deliberately
removed instructions and do not re-enable an explicitly disabled recorder.
Ordinary setup preserves these managed hooks. Add `--dry-run` to preview the
projects and config path without registering or writing project files.

Use `agenticreplay codex-service status --json` to inspect the recorder or
`agenticreplay codex-service disable --json` to stop it and restore the original
Codex endpoint. After disabling, quit and reopen Codex to reload the endpoint.
Use a service-capable AgenticReplay CLI from the same installation when checking
or disabling the recorder.

For an explicit recording session, run `kiokuko setup`, then start the installed Codex app from the
target Git worktree with AgenticReplay 0.1.14 or later:

    agenticreplay record codex --desktop

Quit an existing Codex desktop process before starting the recording. Open the
same worktree in Codex. Kiokuko setup configures Codex to pass the recorder's
private socket to the MCP server. AgenticReplay supplies the socket and scoped
TLS configuration to the desktop process for this recording.

For a task prepared and checkpointed through Kiokuko in the same turn, the
Codex Stop hook binds the successful host-observed MCP calls to the chat,
turn and worktree. This also covers Code Mode calls. Kiokuko waits up to two
minutes for the binding and the exact root turn's completion, then asks
AgenticReplay to seal that turn. Kiokuko checks the trace digest and matching
request and response events. Only evidence attributable to the reviewed turn
enters the proposal.

Kiokuko reads completed Responses output from AgenticReplay's recorded API
payloads, including blob-backed WebSocket/SSE responses. A tool result is included
only when its call ID was generated in that same verified turn. Echoed results
from previous turns are excluded, identical replays deduplicate, and conflicting
results remain ambiguous. The saved evidence includes bounded tool arguments and
result excerpts, source event references and payload hashes. Text saying a command
exited successfully is not treated as structured exit metadata.

The public final answer supplies automatically extracted key points, explicitly
labelled as unverified assistant claims. Reasoning, system prompts and commentary
are excluded. Fields are checked for secrets before excerpts are taken. The native
dialog shows only the save confirmation and compact summary, without internal
identifiers or raw request/result excerpts. Source excerpts and source references accompany the approved
proposal; searches can match the captured results as well as the request and key
points. Reprocessing an older request-only memory requires fresh approval for the
enriched proposal; an earlier approval never authorizes extra content.

The same MCP connection requests native approval. Closing the connection
cancels an outstanding review. Approval is required before the entry becomes
searchable in the project. An explicit desktop recorder socket takes precedence
over `AGENTICREPLAY_RUN_DIR`. With neither set, Kiokuko checks for a running
Dock recorder that allows the current worktree. This check runs after the
checkpoint response.
