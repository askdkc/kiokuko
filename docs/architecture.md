# Architecture

Kiokuko is a model-agnostic local control plane with three deliberately separate stores:

1. curated memory: `entries`, `tags`, and `entry_links`;
2. memory mutation audit: existing `audit_events`;
3. append-oriented execution ledger: runs, events, evidence, context deliveries, feedback, and promotion provenance.

## Boundaries

- Repository detection maps the current working copy to one workspace. Resolution order is portable `.kiokuko.json`, known canonical path, normalized Git remote, then a deterministic local-path identity. Automatic resolution writes no repository files.
- A user-global SQLite database is the source of truth and uses checksum-recorded forward-only migrations.
- A reserved `global` workspace stores only explicitly global cross-project memory. Default recall combines that workspace with the current project and excludes every unrelated project.
- Existing memory services own record/read/search/recall/lifecycle behavior.
- Existing Akinator intake owns task-profile inference, at most three high-value questions, and `ready`/`exhausted` transitions.
- The Agent Event Gateway owns authenticated HTTP/JSON lifecycle, idempotency, event collection, projection, context delivery, and deterministic recommendations.
- Codex/OpenCode ordinary memory access uses a stdio MCP server and the existing memory services directly. Generic execution-ledger commands still call the gateway over HTTP; they never open SQLite for agent-event operations.
- The loopback Web UI reads the same server/service composition and preserves legacy memory routes.

The gateway is not a transparent provider-traffic reverse proxy. Provider credentials and model APIs are outside the v1 boundary.

## Dependency direction

```text
Codex / OpenCode
       ↓ stdio MCP
scoped memory facade
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

- `src/akinator/orchestrator.ts` remains the facade exporting `startAkinator`, `answerAkinator`, and `getAkinatorContext` with their existing shapes.
- `startWebServer(options)`, `/api/health`, `/api/workspaces`, `/api/tags`, and `/api/entries` remain available through the shared server composition.
- Existing CLI commands, JSON envelopes, and exit codes remain stable. `serve`, `server`, and `agent` are additive command registrations.
- `setup` and `mcp` are additive. Existing explicit workspaces remain valid; `use` is optional for the MCP path.
- Existing memory CRUD/lifecycle/export semantics do not absorb ledger records.

## Runtime

A foreground `kiokuko serve --port 0` process keeps one primary SQLite connection, a bounded FIFO write queue, a same-user runtime descriptor, and a same-database instance lock. Only loopback hosts are accepted. `/api/v1/*` uses bearer capability authentication; legacy/UI access is composed separately and does not enable permissive CORS.

## Context loop

A run opens with the shared Akinator intake. Memory is withheld while intake needs an answer. When ready/exhausted, the finalized profile and recommended tags select an initial bounded context. Events then build a deterministic projection. A checkpoint commits events first, projects through the accepted cursor, suppresses unchanged re-delivery, re-ranks memory using current paths/errors/profile/feedback, stores selection reasons and revisions, and returns recommendations. Explicit close, feedback, and candidate-only promotion complete the loop.

All delivered memory/event text is untrusted stored data. The agent must independently verify current files, APIs, versions, and runtime state.
