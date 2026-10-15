# User-reviewed experience memory

Recorded experience is optional assistance. It never grants tool authority, substitutes for actual task verification, or blocks ordinary authorized execution. Native sandbox and explicit human interruption still apply.

The automatic review flow uses the native MCP client question UI described below. It never launches a terminal approval flow or suggests terminal input as an authorization fallback.

For standalone manual maintenance after a task is actually complete, a person may run:

    kiokuko memory-review --cwd /repository --trace /repository/.agenticreplay/runs/RUN --task TASK --session SESSION

The interactive terminal first asks whether the task is complete, then asks permission to organize the selected replay. It resolves bounded inline payloads and SHA-256-validated blobs, excludes model reasoning and system messages, redacts detected secret-bearing fields, and presents the exact proposed JSON and digest. This is a whole-run review; task/session labels are human supplied and are not proof every event belongs to that task. Commands, result references, exit metadata, inferred languages and uncertainty remain visible.

Approve saves the exact displayed revision transactionally. A comment replaces proposed key points, attributes them to the user, increments the revision and shows a fresh preview. Decline, interrupt, restart, missing input, extraction failure and obsolete question responses save nothing. There is no model-facing approval flag or auto-save. This standalone CLI checks terminal interactivity only. A PTY is not authenticated human origin: an agent or other process controlling that terminal can type the same answers. It must not be exposed as the model-facing or automatic approval path, and model-controlled terminal answers must never be treated as user consent.

Approved memories and tag/keyword terms share one transaction with the existing entry search index. An exact approval identity supports read-only reconciliation after an uncertain commit; the host does not automatically retry the write. Retrieval stays repository-scoped, uses the existing hybrid search, and carries evidence references. Tool success alone is not task success. Legacy passive records are not treated as newly approved memories.

## History-informed decisions

- 892dfa6 changed review responses and status reads to preserve revision/cursor snapshots; stale/replayed answers must remain memory-side validation, not an ordinary-tool gate.
- c55350c introduced asynchronous observation and benign bookkeeping failure. Its prior tests expected automatic passive entries and global principle derivation. The new design preserves nonblocking behavior but removes those writers because a lifecycle event is not human permission to save.
- a271f0e improved missing-binding diagnosis. Preserve honest unavailable/unknown diagnostics, rather than silently reporting memory or verification success.
- Existing record validation, repository scoping, secret checks, causal evidence and SQLite transactions remain useful. The memory-review completeness condition is removed from product completion; actual product verification remains independent.

These are source/diff findings, not proof that any historical incident had a single cause. Local verification and platform/CI limitations are reported separately.

## Native MCP client questions

A client advertising MCP elicitation can use `memory_review_completed` on an already completed, repository-bound run. The server asks the client UI for organization permission and then exact-candidate approval. Tool arguments contain no approval boolean. When `AGENTICREPLAY_RUN_DIR` is explicitly configured, completed operational checkpoints queue this optional flow without awaiting human input in the task/database call. Client decline/cancel and unsupported elicitation cannot save. SDK protocol tests are distinct from verification in any particular desktop UI.

A genuinely settled failed task may also be reviewed; its dialog says it ended with a failed outcome and the proposal records that outcome. Interrupted/cancelled tasks and explicit Stop do not start review. Repeated exact source/content approvals deduplicate independently of presentation IDs. Approved mirror retrieval checks the indexed entry revision and status. Confirmed purge deletes the mirror and search terms and retires old approval receipts, so retry cannot resurrect purged material.

After an approved save reports an uncertain result, the host retains that exact candidate and approval key in process and performs read-only reconciliation. Only an independently visible matching committed receipt can report saved. It does not generate a new approval key or blindly retry writes. Restart loses this ephemeral recovery context; an unverified prior save remains unknown rather than being claimed successful.
