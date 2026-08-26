# Architecture

Kiokuko is a model-agnostic local control plane with three deliberately separate stores:

1. curated memory: `entries` (identity/lifecycle), `entry_revisions` (immutable content), `entry_revision_tags`, and `entry_links`;
2. memory mutation audit: existing `audit_events`;
3. append-oriented execution ledger: runs, events, evidence, context deliveries, nudge presentation history, feedback, and promotion provenance.

## Boundaries

- Repository detection maps the current working copy to one workspace. Resolution order is portable `.kiokuko.json`, known canonical path, normalized Git remote, then a deterministic local-path identity. Automatic resolution writes no repository files.
- A user-global SQLite database is the source of truth and uses checksum-recorded forward-only migrations.
- A reserved `global` workspace stores only explicitly global cross-project memory. Default recall combines that workspace with the current project and excludes every unrelated project.
- Existing memory services own record/read/search/recall/lifecycle behavior.
  Hybrid retrieval adds exact-signal, word-FTS, trigram, literal, and tag lanes
  without replacing the existing word FTS index.
- Akinator intake owns task-profile inference, at most three high-value discriminating questions, and `ready`/`exhausted` transitions. Its reasoning projection starts with competing action families and narrows them through intent, target, observable success, selected action, verification, and stop conditions. It is not a retrieval-hit counter.
- The Agent Event Gateway owns authenticated HTTP/JSON lifecycle, idempotency, event collection, projection, context delivery, deterministic recommendations, and advisory nudge selection.
- Codex/OpenCode/Claude Code task preparation uses the stdio MCP
  `task_prepare` / `task_answer` boundary. Human/operator CLI and Web memory
  inspection is management-only, not a model-facing task entry. Generic
  execution-ledger commands still call the gateway over HTTP; they never open
  SQLite for agent-event operations.
- The loopback Web UI reads the same server/service composition and preserves legacy memory routes.

The gateway is not a transparent provider-traffic reverse proxy. Provider credentials and model APIs are outside the v1 boundary.

## Dependency direction

```text
Codex / OpenCode / Claude Code
       ↓ stdio MCP
agent-task preparation / scoped memory facade
       ↓
memory retrieval / candidate record
       ↓
DB adapter

HTTP routes / CLI HTTP client
            ↓
gateway application services
            ↓
Akinator service + ledger/context services
      ↓                    ↓
Akinator pure domain/store  memory retrieval
            ↓
         DB adapter
```

Routes contain no ad-hoc SQLite statements. Gateway run-open and intake-answer use one outer `BEGIN IMMEDIATE` transaction with transaction-agnostic stores. Network source synchronization never holds that transaction or the write queue.

## Compatibility seams

- `src/akinator/orchestrator.ts` exposes intake-only `startAkinator` and `answerAkinator`; the ungated context facade was removed.
- `startWebServer(options)`, `/api/health`, `/api/workspaces`, `/api/tags`, and `/api/entries` remain available through the shared server composition.
- Human/operator memory commands, JSON envelopes, and exit codes remain stable.
  Ungated model-facing compatibility aliases are removed rather than retained.
- Existing explicit workspaces remain valid; `use` is optional for the MCP path.
- Existing memory CRUD/lifecycle/export semantics do not absorb ledger records.

## Runtime

A foreground `kiokuko serve --port 0` process keeps one primary SQLite connection, a bounded FIFO write queue, a same-user runtime descriptor, and a same-database instance lock. Only loopback hosts are accepted. `/api/v1/*` uses bearer capability authentication; legacy/UI access is composed separately and does not enable permissive CORS.

## Context loop

A run opens with the shared Akinator intake. Memory is withheld while intake needs an answer. Each question exposes the decision dimension it discriminates; a ready profile produces a concrete action, verification, stop conditions, and an abstraction-to-action silo score. When ready/exhausted, the finalized profile and recommended tags select an initial bounded context. Events then build a deterministic projection. A checkpoint commits events first, projects through the accepted cursor, suppresses unchanged re-delivery, re-ranks memory using current paths/errors/profile/feedback, stores selection reasons and revisions, returns recommendations, and selects at most one rate-limited nudge from the same committed state. Recommendations describe current conditions; nudges are fixed-message advisory presentations and never commands. Nudge delivery rows are stored outside `ledger_events`, keyed by policy version and logical occurrence, so presentation history cannot alter execution evidence. For each proposed memory, it records one reasoning path per run. A path is qualified only when the run completed, the silo is actionable, and fresh verification or a passing test exists. Retrieval impressions never enter this table. Explicit close, feedback, Curator review, and candidate-only promotion complete the loop.

Curator aggregates qualified paths by a server-derived generalized concept key. Two or more independent successful runs, high silo completeness, and either cross-workspace evidence or explicit structured applicability produce `skill-ready`. Lower-evidence candidates remain inspectable for manual judgment. Automated client guidance calls `curator_check` before the terminal checkpoint and always asks the user before `curator_globalize`.

External skill lookup is not a general context backfill. Task preparation uses
`official` discovery by default; `KIOKUKO_SKILL_DISCOVERY=community` broadens
the search and `KIOKUKO_SKILL_DISCOVERY=off` disables it. Task preparation derives
technology gaps from the project fingerprint and uses the provider boundary in
`src/skills` to search and validate commit-pinned GitHub snapshots. The result
is stored once in a dedicated external workspace as candidate/untrusted
reference memory, then included only through explicit Ecosystem applicability.
Community mode additionally requires a GitHub source, a safe repository/skill
path, and a non-duplicate candidate before automatic import. Every candidate
outside Kiokuko's exact locally reviewed source/slug/path catalog requires a
fresh provider audit result with `passed` status; missing or failed audit
results fail closed. Provider-supplied `curated`, `catalog-verified`, or
`owner-verified` labels are ranking metadata, not materialization authority.
Interactive setup keeps `official` as the default and asks before persisting
`community` into each selected client's MCP subprocess environment. Batch setup
uses `--skill-discovery`; omitting it preserves an existing managed mode.
The default is `official`. Legacy fixed-source network sync and guessed-source
fallbacks have been removed; bounded exact verification of a reviewed,
catalog-pinned source remains.
Normal `task_prepare` and `kiokuko skills find` use the shared provider-backed
discovery path. ContextBroker retrieval is exposed to task-aware clients only
through the capability-gated task and Agent routes.

Provider search outcomes and typed source transport failures use separate,
provider/source-bound persistent caches. Search, source, and provider-audit
caches have strict canonical expiry timestamps and are pruned together; a
malformed row aborts the entire prune instead of being skipped.

Discovery never starts `npx` or arbitrary child processes, never installs or
executes fetched skills, and never registers MCP servers. Provider failures
degrade to ordinary Kiokuko retrieval. The migration-owned tables
`external_skills`, `external_skill_entries`, `external_skill_generation_clock`,
`external_skill_generation_tokens`, `skill_discovery_cache`, and
`skill_source_failure_cache`, plus `skill_audit_failure_cache` keep source state,
bounded mutation generations, snapshot mappings, search results, source
backoff, and provider-audit backoff separate from ordinary project memory.

All delivered memory/event text is untrusted stored data. The agent must independently verify current files, APIs, versions, and runtime state. Normal MCP task preparation persists a scoped project/global delivery with a versioned ranking schema; a terminal checkpoint can close the linked run while recording bounded evidence, feedback, and candidate-memory ledger links.
