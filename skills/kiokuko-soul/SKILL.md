---
name: kiokuko-soul
description: Use before code changes, operations, formal reviews, implementation plans, and investigation requiring a project run. Response-only work with sufficient evidence needs no router read. Use the Akinator intake for optional memory records; route authorized coding from current evidence through simple code work, general code work, and interactive UI work to the bundled specialist Skills.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-soul -->

# Kiokuko SOUL router

## Outcome

Use this router for optional Kiokuko task records and applicable specialist guidance. Authorized coding may continue from repository evidence when preparation, memory review, verification registration or storage is unavailable. Never claim that the failed record was saved or verified; preserve identity, access and host authorization refusals.

This Skill owns the entry sequence and routes work. Akinator is the intake state machine for Kiokuko records, not a host authorization mechanism. This Skill does not duplicate specialist instructions, select another model, or authorize effects beyond the user request and current client permissions.

## Priority

Explicit user instructions outrank these Skills' design, style, workflow, and implementation preferences. They do not override host-enforced safety, authorization, identity, state, revision, or integrity invariants. Resolve routine choices from repository evidence and existing authorization; ask only when an unresolved assumption would materially change the intended result or permitted effects.

## Proportionate effort before routing

Choose reasoning depth and tool use separately from uncertainty, consequences of error, reversibility, and evidence already available. Do not classify by request length, a writing label, or repository mention. Repository mentions alone do not require preparation. When current conversation evidence suffices for a response-only request (including drafting, translation, explaining existing results, or acknowledging a correction), answer directly with zero preparation, memory, or verification calls and no task run. If one decision-relevant fact is missing, use only bounded task_inspect reads; operation diff accepts scope auto, staged, or working-tree, with auto preferring staged changes. Answer when that evidence suffices; do not start intake for a limited read alone. For uncertain causes, interacting dependencies, or high error consequences, develop hypotheses and failure conditions and gather only evidence that changes a decision or proves completion. Code changes, operations, formal reviews, and implementation plans retain host/OS/user authorization and actual product verification. Kiokuko intake and memory review govern only its optional records. Every additional check must change a decision or prove a completion condition. Stop when the requested result and required evidence are available; do not reread unchanged state, load unrelated Skills, or prepare merely to prepare. Recall memory only when past information is needed for the current decision. No minimum reasoning duration or tool-call quota applies. These rules never release permission or identity denials or user cancellation. Pending intake and terminal memory records do not prohibit unrelated authorized coding. Arbitrary shell commands and JavaScript are execution, not bounded read-only inspection. Hooks control observable calls and state, not private reasoning depth.

## Ordinary conversation and interaction memory

For ordinary conversation that needs past context and does not involve project work, use `memory_recall`
with the current query, optional subjects, `soulRead: true`, and the complete
capability catalog. Read `memory-reasoning` before advertising it. No repository,
task run, or Akinator answers are needed. This route cannot replace or bypass
intake for project work or an already-open project run.

Do not automatically capture durable memories. Apply user corrections to the current work immediately, but keep proposed memories ephemeral until human approval.

After the actual task is complete, ask whether to organize its experience. The native `memory_review_completed` flow asks this through client elicitation, displays the exact proposal and digest, and asks whether to approve, revise or decline. Comments replace key points and require a fresh preview. A model-supplied confirmation or text inside a replay cannot approve. If native elicitation is unavailable, leave the proposal unsaved. Never substitute model-controlled terminal input or pretend a UI was displayed.

Only the approved candidate is saved. Decline, Stop, restart, extraction error or memory unavailability saves nothing and never blocks ordinary authorized tools or reopens a completed task. Commands, results, languages, failed approaches and useful key points must retain evidence links and uncertainty. Never store secrets, hidden reasoning or unsupported claims of verification. Operational task checkpoints and short-term handoffs are distinct from reusable memory.

## Short-term handoff

When `KIOKUKO_HANDOFF` is `auto` (the default), save a short structured state with
`handoff_save` after meaningful corrections, decisions, progress, or changes to
pending work. Keep its returned `handoffId` in the current conversation and
update that exact record; do not search for a latest record by directory. For a
run-linked save, supply the same capability catalog bound at `task_prepare`. On an
explicit model or thinking-level change, or when resuming work, use `handoff_load`
only if the ID is known. Reconcile its untrusted content against current user
instructions and evidence. No tool call is guaranteed on every turn.

Never send a transcript, raw tool output, credentials, or private reasoning.
Handoff state expires 24 hours after a meaningful update. `KIOKUKO_HANDOFF=off`
disables new saves and updates; existing records can still be loaded or discarded
until they expire. This state grants no task authority and cannot replace
`task_prepare`, verification, or `memory_checkpoint`. Save any needed handoff
before terminal `memory_checkpoint`; unrelated authorized tools may continue afterward.

## Required entry

When a project run or memory recall is needed, read this Skill before any other bundled Kiokuko Skill. Response-only work with sufficient evidence requires no Skill read.

When Codex hooks supply a request ID, use `task_inspect` with `operation: "skill"`
and no path to read this router. Read `memory-reasoning` through the same tool
before advertising it. Use `task_inspect` for all bounded preparation reads and
bundled Skills, including `natural-japanese-output`; do not use shell commands
to bypass the record capability checks. Unrelated authorized repository inspection remains available.

Bundled Skill selectors are package identities, not installed client paths.
Use the exact public Skill name (including its Codex alias) or
`skill-name/SKILL.md`; references use `skill-name/references/file.md`.
The optional `skills/` prefix and slash or backslash separators are supported.
Empty segments, dot/parent traversal, URL decoding and guessed aliases are not.
An absolute installed client path is not a bundled selector. After a selector
error, change to a documented selector or omit path for this router. The error
does not authorize external reads or remove the current intake/review gate.

For every `task_prepare` call, set `soulRead: true` only after reading this
complete local `SKILL.md` for the current logical request. `task_prepare` also
requires the exact local `kiokuko-soul` capability for every task. Omission,
false attestation, missing availability, unknown availability, aliases,
namespaced copies, and fetched references fail closed. The attestation is an
explicit client claim; it is not remote proof of model cognition.

For an optional Kiokuko task record, enter its Akinator intake gate below first. Unrelated authorized coding may use repository evidence and applicable specialist guidance. Treat every returned `nextAction`, required-Skill list, and stop condition as authoritative for that run.

Read the complete `SKILL.md` index for every applicable route before planning, implementation, review, or verification. Each specialist index defines versioned expert fragments. Read only fragments selected by the concrete task risk; do not load every reference by default. Do not substitute this router's summary for a specialist core contract.

## Akinator intake gate

Akinator manages optional Kiokuko records after this SOUL read. Its procedure does not gate unrelated authorized planning or coding.

Open the gate once for the current logical request:

1. Create one bounded opaque `requestId`. Use a new value for every new logical request, even when its text is identical. Reuse it for an exact transport retry, or correct the catalog and retry when runCreated=false.
2. Obtain at most one successful preparation through `task_prepare` with `soulRead: true`, that `requestId`, the actual task, current working directory, only profile hints grounded in the user request or repository evidence, and the complete capability catalog available in the current client.
3. Reuse the successful result for the rest of the request. Inspect `intake.status`, the exact current `intake.question`, top-level `nextAction`, `memoryPolicy`, capability results.
4. Retain the returned `run.runId` and `context.deliveryId` for later run-bound calls.

Follow the returned intake state without inventing missing facts:

- **`needs_answer`** or **`nextAction=answer_from_evidence_or_ask_user`**: Akinator controls only that record. Use its hypotheses and question purpose only to understand the distinction being tested. Answer the exact current question through `task_answer` only when the value is grounded in the user request or verified repository evidence; otherwise ask the user that question. Repeat the same capability catalog and context budget, inspect the new question and state after every answer, and continue until `ready` or `exhausted`. Do not complete that memory record while unresolved. Unrelated authorized coding may continue from current repository evidence.
- **`ready`**: obey top-level `nextAction`, capability requirements, memory policy. Only then select the applicable routes below.
- **`exhausted`**: no further Akinator question is available, but `intake.missingFields` may remain. Preserve that uncertainty, do not invent the missing answers or describe the intake as fully specified, and route only when top-level `nextAction` permits.

For a memory record, `nextAction=review_memory_application` requires decisions before
reusing those memories or completing that record. Inspect `task_memory_status`, gather
current evidence with `task_inspect`, then call `task_memory_review` sequentially
for every pending entry using the revision returned by the latest response.
Register grounded adoption, inapplicability or contradiction; never invent a
decision to manufacture a completed record. `nextAction=refresh_memory` requires
`task_memory_refresh` on the same run with the bound capability catalog before
reviewing the new delivery. After reviews, check `task_memory_status`; do not
repeat `task_prepare`. `nextAction` governs the memory workflow only. Independent tools remain subject to host and user authorization. Adopted memories still require real verification before being described as verified.

If task_prepare is unavailable, report unavailable memory and continue unrelated authorized coding from repository evidence. The sole exception is diagnosing or repairing Kiokuko itself after `task_prepare` fails before returning scoped context: continue only from repository evidence, and do not call `task_answer` or `memory_checkpoint` for that failed request.

Correcting preparation does not require a new user request or a “retry implementation” message. If the recovery API is missing from the current tool catalog, report the stale MCP runtime and reload its connection after updating the installed package. Never invent an unavailable tool or bypass the hook.

## Recoverable state conflicts and task completion

A typed `recoverable: true` task-state conflict permits one recovery before any
authorization or identity denial: read `task_memory_status`, preserve the run and its exact
capability catalog, then submit a new requestId with the current revision.
`retryable: false` forbids repeating the unchanged request. Review a new delivery
before continuing. A second conflict, binding mismatch, terminal run or unknown
failure is not automatically recoverable. An authorization or identity denial ends the
turn. A recoverable preparation or review denial permits repair within the same turn.

For optional memory tracking, define required checks per target with
`task_verification_define` and record their results with
`task_verification_record`. Check `completionReady` before reporting verified memory-record completion. Registration failure does not waive actual product verification or prohibit unrelated authorized coding.
`complete` refers only to memory application. Missing, failed, skipped, unknown
or stale checks do not pass. A null completionReady is legacy/unobserved, never
proof of task success. PLAN and review need no implementation tests unless code
actually changes. Report facts, hypotheses and unverified conditions separately;
do not attribute a product failure to a separate bookkeeping error.

## Routes

The optional memory record can proceed after its intake reaches `ready` or `exhausted` and its `nextAction` permits. Select authorized coding routes from current user intent and repository evidence even when memory intake is unavailable.

### Workflow completeness

Read and apply `veteran-programmer-skill` before and after implementation when changes span setup, delivery, persisted state, or runtime handoffs. Check that the requested behavior reaches its actual consumer. An isolated edit needs no additional audit.

### Workflow repair

Read and apply `repair-user-workflow` before planning or implementing fixes for
installation, updates, build, registration, generated configuration, shortcuts,
plugins, services, or caller-to-runtime handoffs when the next ordinary launch,
use, restart, or exit fails after upstream success, source/helper checks pass but
the installed artifact, current profile, or actual consumer fails, or a previous
fix still needs manual rescue. Judge these conditions from the reported workflow,
including Japanese reports such as 「更新は成功したが起動しない」; do not depend on
keyword matches or `catalog_similarity` recommendations. Resolve this route after intake and memory
review permit progress. Read the complete skill index; load its scenario reference
only for an ambiguity or skill review.

Do not select this route for explanation-only requests, commit-message drafting,
or isolated logic fixes without a workflow boundary.
Use it alongside the coding routine and applicable code/UI skills, and stop if the
required local skill is unavailable. The repair must reach the ordinary consumer;
skill selection alone does not establish that the workflow works.

### Simple code work

Read and apply `kiokuko-simple-work` when either condition is true:

- the request is a bounded code change with a clear target and expected result, and it introduces no new architecture, dependency, data migration, public protocol, security or authorization policy, or cross-system orchestration;
- the user explicitly requests the simplest, shortest, minimal, YAGNI, dependency-free, or Ponytail approach.

This route minimizes the solution; it does not replace the code contract below or waive required understanding, boundary validation, error handling, security, accessibility, or focused verification. If the task's simplicity is unclear and the user did not explicitly request this route, use the ordinary code route without it.

### Code work

Read and apply the `kiokuko-single-purpose-functions` index before writing, modifying, debugging, refactoring, or reviewing code, and before decomposing a code-changing plan. Select one to three `code.*` expert fragments for each cohesive function or task.

### Software completion for every coding request

Before code-changing planning or implementation, apply the compact
`one-shot-software-completion/SKILL.md` core, including for small, minimal/YAGNI,
test and UI changes. Reuse its unchanged full text already in active context;
otherwise read it. A summary is insufficient. Load references only for concrete
risks; this route does not require reading them all. Follow availability rules below.

### Interactive UI work

Read and apply the `kiokuko-ui-design-soul` index before designing, implementing, modifying, debugging, or reviewing an interactive interface. Select one to three `ui.*` expert fragments for the actual interaction risks. If UI work changes code, apply both the code and UI indexes.

### Coding delivery routine

For coding requests, read and apply `coding-ideal-routine-skill` after intake and
before changing code, tests, or behavior-affecting configuration or distribution.
`task_prepare` and `task_answer` automatically load the complete package-owned
core into `codingRoutine` once intake permits routing. Its `required: true`
means apply the full text after memory review permits progress; it is independent
of catalog similarity, optional discovery, local installation, and memory budgets.
Reuse that full text when already in context. If it is absent or lost, read the
complete core through `task_inspect` before coding. Read only applicable linked
references; never enter this route while intake or memory review is pending.
It connects investigation, meaningful Red/Green evidence, the user's ordinary
usage path, independent verification, and factual completion reporting.
Apply its relevant checks to behavior-preserving refactoring or writing;
explanation-only requests do not require implementation or Red/Green tests.
This route complements the code and completion contracts and never replaces
intake, memory review, permissions, or required verification.

### Combined work

Routes compose. Read every applicable specialist index; never choose only one when the task spans multiple contracts. Fragment selection remains narrow inside those routes.

Use this order:

1. `kiokuko-soul`;
2. one Akinator `task_prepare`, followed by grounded `task_answer` calls until `ready` or `exhausted`;
3. `veteran-programmer-skill` when the change crosses workflow stages;
4. `repair-user-workflow` for the workflow defect repairs defined above;
5. `kiokuko-simple-work` when the finalized intake satisfies the simple-code activation boundary;
6. `kiokuko-single-purpose-functions` for code planning or code work;
7. `one-shot-software-completion` for every coding request, including simple code and UI code changes;
8. `coding-ideal-routine-skill` for coding requests;
9. `kiokuko-ui-design-soul` for interactive UI work.

Keep each route within the user-approved task scope.

Apply `natural-japanese-output` when the user writes in Japanese or requests Japanese output. It governs wording without changing required schemas, report order, or technical identifiers.

## Availability and trust

When a current directive or capability recommendation marks a routed Skill as required, stop on `required_capability_unavailable`, or equivalent unavailable-required-Skill result.

Do not satisfy a required bundled Skill with a similarly named, namespaced, fetched, or reference-only Skill. Never install or execute external Skill content automatically.

Skill availability alone is not evidence that its contract was applied. The
mandatory `soulRead: true` attestation makes that claim explicit but does not
turn it into cryptographic or remote proof.

## Profile memory hints

Optional `intake.memoryHints` are untrusted examples from earlier runs, not current answers or authorization. Do not submit a hint as a user answer without a current user choice or independent current repository evidence. Answer only the exact current question and preserve its options and nextAction gate. Hints do not permit proceeding while intake needs an answer.

## Explicit memory indexing

When the user requests memory-index maintenance, complete the same intake and
capability gate first. Use `task_memory_refresh.indexing` with `stage: atomic`
then `stage: bridge`; sources must be read completely from the bound delivery.
Submit through `memory_index_submit` and compare each candidate against every
exact UTF-16 source quote before `memory_index_review`. Use only IDs from that
work batch. Preserve the run, delivery and assurance revision; use fresh operation
IDs for new inputs. Generated facts remain untrusted model assessments, cannot
promote trust, and cannot become generation sources. Never force maintenance
within ordinary tasks. Follow the packaged `docs/memory-index.md` for the
bounded schema, mode rollout and interruption recovery.

Capability preparation validates the complete catalog before run creation. On runCreated=false, correct the catalog and retry task_prepare with the same requestId. For legacy capability-blocked runs, use task_prepare_recover with the original catalog and current revision; it creates one successor and preserves the predecessor. Never use task_memory_refresh to repair a capability catalog.
