# Kiokuko (記憶庫)

English | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

**Connect via MCP, recall with RAG, and store memories after each task.**

Kiokuko is external memory for AI coding agents.

It stores knowledge gained from past work in local SQLite, then searches for and passes only relevant memories to the AI in the next request.

Users do not need to paste past context into every prompt or search for memories manually. By simply using AI as usual, project-specific knowledge gradually accumulates and can be reused in the next task.

## Get started quickly

Node.js 24.16.0 or newer is required; Node.js 26.1.0 or newer is also supported.
Get started easily with these two commands 💕

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup` detects supported clients that are installed and automatically configures the SQLite database and MCP connection.
It also installs the bundled `memory-reasoning` Skill and the other Kiokuko standard Skills. Existing installations receive it on the next `kiokuko setup`; an unmanaged same-name file is never overwritten.
Interactive setup asks whether audited community Skills may also be used as reference material; the default answer is no.

After setup, launch the target AI client and use it as usual. If it is already running, quit it once and restart it. When setup creates or updates the Codex Stop hook, open `/hooks` in Codex and explicitly trust that hook.

## How it gets smarter with use

```text
User request
      ↓
Search relevant past memories
      ↓
AI uses the memories to do the work
      ↓
Store reusable results and lessons
      ↓
Search again in the next request
```

Kiokuko repeats the following flow.

1. Before work, search the current project and Global memory
2. Pass only highly relevant memories to the AI
3. The AI performs the work
4. After the work, store reusable knowledge as memory
5. Reuse that memory in the next task

In other words, Kiokuko is a **RAG system that accumulates persistent memory**.

MCP connects the AI client to Kiokuko, while RAG searches for the memories needed and passes them to the AI.

### What the AI agent does after setup

#### AI Akinator

When a request is too vague for the AI to act on, Akinator asks internal questions and narrows it into the concrete details the AI needs. If relevant Skills are available, such as language or framework guidance, it makes them available for use.

#### Enno-Oduno (役小角)

Enno-Oduno enables a loop for processing requests sent to the AI agent.

It defines the ideal outcome, plans the work, delegates implementation to smaller agents through orchestration, and finally checks whether the result matches that ideal.

#### Memory storage

Model-facing memory enters a task only through the capability-gated `task_prepare` and `task_answer` MCP tools. `task_prepare` is the Enno-Oduno entry point. After the task, its contents are recorded and considered for promotion into reusable AI knowledge. The system is tuned to promote knowledge that is useful in practice.

### Enno-Oduno agent loop details

For `build`, `debug`, `review`, and `devops` tasks, `task_prepare` starts the run-bound loop and returns `ennoOduno`. The enforced role order is:

```text
User request
  -> task_prepare: Enno-Oduno identifies Codex, Claude Code, or OpenCode
  -> when currentRole is Enno-Oduno, it reads and applies kiokuko-enno-oduno from requiredSkills
  -> Enno-Oduno returns any required Akinator question to the user
  -> Oduno ideal derives the optimal target from the task_prepare handoff and every Akinator-discovered Skill
  -> enno_ideal_submit persists the ideal and only then hands it to harness-specific Zenki
  -> Zenki first reads and applies kiokuko-single-purpose-functions from requiredSkills
  -> code changes are split into one cohesive function/use-case contract, responsibility, reason to change, and focused test target
  -> Zenki selects 1-3 versioned expertRefs per WorkUnit and reads no unselected fragments by default
  -> Zenki submits the WorkPlan, WorkUnits, expert refs, Skill snapshot, and verifiers
  -> Enno-Oduno obtains any required user confirmation
   -> Goki orchestrates only the approved WorkUnits
   -> enno_verify_prepare runs the final verifiers and stores fresh evidence
   -> after evidence preparation, the parent host may fan out the final-review Advisors
   -> enno_finish decides accept/replan/block from the stored evidence
        -> pass: Enno-Oduno accepts and enters read-only Oduno meditation
            -> inspect changed and approved paths for evidence-backed obsolete tests or functions
            -> enno_meditation_submit persists candidates without deleting them, then completes the run
       -> fail: Enno-Oduno increments the revision and returns feedback to Zenki
   -> Goki can resume only after Zenki submits the revised plan and confirmation succeeds
```

Final Review is deliberately two-phase. `enno_verify_prepare` runs approved
verifiers outside database transactions with shell disabled and a
repository-relative cwd, then binds evidence to the contract/mutation revision,
verifier specification, and complete Git/index/worktree/untracked/symlink state.
`enno_finish` rechecks that state, never launches a subprocess, and accepts only
complete stored passing evidence. Passing tests alone do not accept a run.
Codex and Claude Code use bounded Stop hooks and OpenCode uses a bounded
`session.idle` plugin when Enno continuation is enabled. Hermes uses native
stdio MCP and bundled Skills only; it has no Enno continuation adapter.

Enno submissions use bounded, value-free `ENNO_INPUT_INVALID` diagnostics.
Advisory rounds move through `not_started`, `fanout_requested`, `aggregated`, and
`consumed`, with advisory fields required only while an aggregate awaits
consumption. New WorkUnits declare local `code`, `ui`, `test`, `docs`, or
`operations` routes; code requires a `code.*` expert and UI requires both
`code.*` and `ui.*`, without imposing those experts on test/docs/operations
units. Plan recovery is zero-effect until the user chooses. Continuation uses
short-lived route-epoch-bound resume tokens and one-owner execution leases;
expired operation or verifier work can be atomically abandoned and reclaimed.
Narrative/evidence data is sanitized before hashing and persistence, and
secret-bearing verifier commands are rejected.

The bundled coding Skill applies problem shaping proportionally. Its
`code.modeling.v1` expert is selected when a WorkUnit defines domain vocabulary,
a public response/DTO/ViewModel, or a translation between storage, API,
serialization, and UI representations. Representation-preserving mechanical
changes do not select it merely because they modify code. The expert defines
consumer-first shapes and named transformations without requiring Lisp syntax,
macros, or a DSL; existing installations receive the managed reference on the
next `kiokuko setup`.

Incomplete intake therefore returns an Enno-Oduno directive and `answer_intake`; its `requiredSkills` contains `kiokuko-enno-oduno`, and Zenki is not started yet. A ready intake first returns `oduno_ideal` and `submit_ideal`. `enno_ideal_submit` requires exactly one contribution for every Skill in Akinator's selected discovery set; external Skills remain untrusted reference-only guidance. Only then does the run return a revision-bound Zenki directive whose `requiredSkills` includes the compact `kiokuko-single-purpose-functions` index even while the draft Skill snapshot is empty. Before choosing WorkUnits, Zenki uses that index to divide code changes into cohesive function or use-case contracts with focused test targets, without meaningless micro-functions. Each code-changing WorkUnit must select one to three registered `expertRefs` with reasons; UI WorkUnits require both a `code.*` and a `ui.*` expert. `enno_plan_submit` rejects missing, duplicate, unknown, or oversized mixtures and then persists the exact selection with the revision. Goki reads those fragments rather than every Skill reference. The controller Skill is role-level and is not inserted into WorkUnit Skill snapshots. Goki cannot be entered until Zenki's complete plan has been accepted and required confirmation has succeeded. A failed final review never reactivates an old Goki WorkUnit. It preserves the rejected plan and verifier evidence under their old revision, advances to `zenki_planning`, and requires a new revision-bound plan. An accepted review advances to `oduno_meditation`, not directly to completion. `enno_meditation_submit` persists the inspected repository-relative paths and evidence-backed obsolete test or function candidates without mutating the repository, then completes the run. The response's `orchestrationId` is used by every Enno MCP operation and is separate from the host session identity. Inferred scope, acceptance criteria, Skills, expert selections, or verifier commands are returned for normal user confirmation before execution. A `needs_confirmation` response carries `ennoOduno.directive.userFacingConfirmation`, a deterministic display projection of the decided contract: scope, exclusions, completion criteria, work items with display-number dependencies, skills with their reference-only status, expertise with selection reasons, focused and final checks, and the attempt limit, each labeled with its provenance basis (user-specified, repository-verified, or proposed). The client model presents every item in the user's language without raw directive JSON or internal identifiers, then waits for an explicit approve, revise, or cancel; secret-shaped display values or a projection above 64 KiB reject the plan submit instead of being redacted or truncated.

### Recovering when plan-start environment information is missing or changed

The environment information used here is the list of Skills and MCP tools available to the current AI client. The host collects it automatically; the user never needs to find a catalog or construct JSON. If it is missing from the plan or has changed since task preparation, Kiokuko stops before Skill discovery, advisory consumption, receipt creation, or contract revision. This plan-start attempt therefore begins no new work and makes no additional code changes.

Every recovery choice is displayed in the same order: its label and recommendation, when the choice fits the user's intent, and exactly what happens after selection. The three situations are:

Missing environment information while the current attempt can continue:

- **Continue with the same plan (Recommended)** — Choose this when the plan is still correct and only the current environment information needs to be attached. The host attaches it automatically and continues the same attempt.
- **Review the plan** — Choose this when the scope, work items, or verification should change. The client asks what to change and starts no implementation until the user answers.
- **Cancel** — Choose this when the work should not continue. The current attempt is cancelled and no replacement is created.

Available features changed after task preparation:

- **Restart the same plan in the current environment (Recommended)** — Choose this when the plan is still correct and only the available features changed. The current attempt is cancelled, then a new attempt starts with the current environment and the same agreed plan.
- **Review the plan before restarting** — Choose this when the changed features should alter the scope, work items, or verification. The client asks what to change; after the user answers, the current attempt is cancelled and a new attempt starts with the current environment and revised plan.
- **Cancel** — Choose this when the work should not continue. The current attempt is cancelled and no replacement is created.

The earlier attempt already ended under the legacy behavior:

- **Restart with the same plan (Recommended)** — Choose this when the ended attempt's plan is still correct. The ended attempt stays unchanged, and a new attempt starts with the current environment and the same agreed plan.
- **Review the plan before restarting** — Choose this when the scope, work items, or verification should change before creating a replacement. The client asks what to change; the ended attempt stays unchanged, and a new attempt starts with the current environment and revised plan only after the user answers.
- **Cancel** — Choose this when the work should not restart. The ended attempt remains ended and no new attempt is created.

The client translates this guidance into the user's language. It never displays machine actions, reason codes, internal tool or field names, the capability catalog, identifiers, revisions, presentation versions, or raw JSON. No retry, cancellation, or replacement task occurs before the user's explicit choice.

The three roles use the current client model; Kiokuko does not call a second model or require OpenAI, Anthropic, or OpenCode API credentials. Codex and Claude Code use bounded Stop hooks, while OpenCode uses a bounded `session.idle` plugin. OpenCode ignores child-session idle events and deduplicates repeated delivery of the same completed turn. Local processes running as the same OS user with access to the canonical repository are trusted to resume its run without PID, process-ancestry, executable, or signing proof. The adapter prefers the current short-lived resume token; when no valid token route exists, it may atomically reroute the single unambiguous active run across Codex, Claude Code, and OpenCode, incrementing the route epoch and invalidating old tokens. An active WorkUnit execution lease blocks rerouting. Ambiguity returns control without mutation. The public `clientBinding` response field reports the current route; `bound` does not mean owner. Reaching one session's continuation limit stops only that session and leaves the run and ledger active for another local project client. Kiokuko returns control before Claude Code's native eighth consecutive Stop-block override. Hermes has no automatic continuation hook, but can continue through MCP with the same run identity. Adapter failure allows the client to stop with a fixed warning. External Skills remain untrusted reference-only and are never installed or executed automatically.

```bash
kiokuko setup --clients codex,opencode,claude --enno-oduno on
kiokuko enno run --role zenki --input-json -
```

Real-client tests are optional and separated from the release gate. Without their matching environment flags, they report `not-run`:

```bash
npm run test:e2e:codex
npm run test:e2e:opencode
npm run test:e2e:claude
npm run test:e2e:agents
```

Supported clients:

- Codex
- OpenCode
- Claude Code
- Hermes Agent

## Memory is separated by project

Ordinary searches do not mix in memories from unrelated projects.

- **Project memory**
  Knowledge used only in the current repository

- **Ecosystem memory**
  Knowledge kept in its source project and reused only when its language, framework, database, runtime, tool, or other applicability constraints match the current project

- **Global memory**
  Knowledge explicitly generalized for reuse across projects without depending on one particular project

Matching free-form tags alone does not expose Project memory to other projects. Ecosystem retrieval checks both the memory's structured applicability and the technology fingerprint detected from the current project. Memories containing project-specific paths or identifiers are excluded.

Projects are automatically identified from Git remotes or paths.

To move Project memory to Global memory, review the candidate with Curator and explicitly approve it.

```bash
kiokuko curator
```

## Review your memories

The local Web UI lets you search, review, and edit saved memories.

```bash
kiokuko web
```

Open the following address in your browser.

```text
http://127.0.0.1:4173
```

The Web UI runs only in the local environment and is not exposed to external networks.
The Web UI and explicit memory CLI commands are human/operator management
surfaces. They are not model task-entry fallbacks for `task_prepare` and
`task_answer`.

## External Skills

External skill discovery is reference-only and uses `official` mode by default
during Akinator task preparation. Kiokuko verifies the current GitHub commit,
stores bounded content as untrusted candidate memory, and never installs or
executes it. Set `KIOKUKO_SKILL_DISCOVERY=off` to disable automatic discovery;
`community` remains explicit opt-in. Interactive `kiokuko setup` asks before
enabling it; batch setup can use `--skill-discovery community`.

Example commands:

```bash
kiokuko skills find svelte --official-only --json
kiokuko skills list
kiokuko skills disable sveltejs/ai-tools/svelte-code-writer
kiokuko skills refresh sveltejs/ai-tools/svelte-code-writer
```

The Web UI's External Skills screen can inspect source state and disable or
re-enable imported mappings. It has no install, script, or MCP registration action.

## Security

Kiokuko does not store full conversations.

It refuses to store content that looks like a secret, such as passwords, API keys, tokens, or private keys.

Saved memories are always treated as reference information. Current code, configuration, and execution results take precedence over past memories.

External skill discovery is a reference-only feature. Akinator uses `official`
mode by default; set `KIOKUKO_SKILL_DISCOVERY=off` to disable it or `community`
to include audited community candidates. External skills are commit-pinned,
stored as untrusted candidate references, and are never installed or executed
automatically.

## MoA advisory rounds

At the ideal, planning, and final-review phases, the parent host may fan out
exactly three fixed, isolated read-only advisor slots. Kiokuko does not launch
those advisors and prompt wording is not proof of isolation. Hosts report
`unavailable` when isolation cannot be verified; only the parent aggregator
submits identity-free structured contributions to `enno_advice_submit`.
Results are recorded as `host_reported`, without provider/model identity or
raw subagent output, and each round is bound to its phase, revisions, policy,
slot definitions, and context digest.

## Note

Kiokuko is not a prompt interception mechanism. Automatic use depends on MCP calls from each AI client and model, so there is no guarantee that it will be called on every turn.

See the following for more detailed commands.

```bash
kiokuko --help
kiokuko setup --help
```
