# Nonblocking, user-approved memory

The previous passive writer contract is superseded. A completion, compaction, complaint, praise, model switch or timer is not permission to save derived memories.

Compatibility `memory_observe` and `memory_improve` MCP/HTTP operations now return `recorded:false`, `workMayContinue:true`, and `post_task_review_required`. They do not stage candidates in SQLite. `memory_context` continues to retrieve scoped approved/explicit memory as untrusted evidence; old passive observations and automatic global principle projections are excluded from this route.

The ordinary ChatGPT/Codex flow is: actual task completion → model organizes one to
five useful durable memories → `memory_capture` displays the exact proposal and
SHA-256 digest in native MCP elicitation → human save/decline → save performs the
existing atomic capture, while decline saves nothing. There is no approval flag in
tool arguments, and unsupported elicitation cannot save.

The separate AgenticReplay maintenance flow is: actual task completion → native
ephemeral replay extraction without a permission question → display exact
revision/digest → human approve/revise/decline → atomic approved save. Read
[the replay review contract](replay-memory-review.md).

Clients advertising MCP elicitation receive native form questions. Ordinary sessions
use `memory_capture`, which needs no replay directory. `memory_review_completed`
remains the evidence-backed AgenticReplay path: it checks that its run is already
completed and matches the repository. A successful empty-memory operational
checkpoint schedules that replay flow asynchronously when an explicit
`AGENTICREPLAY_RUN_DIR` is available. It does not hold the completed task or its
database operation open while the human decides. Without a supported client UI or
source path it reports that review was not started; the interactive CLI remains
available.

Derived-lesson, index-submit, globalize and nonempty-memory checkpoint routes cannot
save by asserting consent. `memory_capture` can save only after its native human
question returns save for the exact displayed digest. Machine CLI record/globalize
calls also cannot authorize memory. Interactive human record displays the exact input
before asking for approval. Task/continuation state is operational metadata, not
reusable derived knowledge.

No user databases, live settings, saved runtime, Mac installation or Git remote were modified during development. Existing native sandbox controls and explicit interruption remain unchanged.
