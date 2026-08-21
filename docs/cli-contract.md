# CLI contract

Existing memory commands and their JSON envelopes/exit codes remain stable. Machine-readable commands write exactly one JSON object to stdout; diagnostics go to stderr.

Success:

```json
{"apiVersion":"1","ok":true,"operation":"recall","data":{},"meta":{}}
```

Failure:

```json
{"apiVersion":"1","ok":false,"operation":"record","error":{"code":"VALIDATION_ERROR","message":"...","details":{}}}
```

Exit codes remain: 0 success, 2 usage, 3 validation, 4 not found, 5 conflict, 6 database/service, 7 security rejection, 8 integrity/doctor, and 9 partial filesystem transaction.

## Global client setup and MCP

```bash
kiokuko setup [--clients codex,opencode,claude] [--command kiokuko] [--dry-run] [--json]
kiokuko mcp
```

`setup` initializes the user-global database and safely merges Codex, OpenCode,
and/or Claude Code MCP and global instruction configuration. It computes and validates all
file edits before writing, uses per-file atomic replacement, rolls back already
written client files if a later write fails, rejects symlinks, and is
idempotent. Before an existing database is migrated, `setup` creates and verifies
a pre-migration SQLite backup and returns its path as `databaseBackupPath` in JSON.
It rejects databases created by a newer Kiokuko schema before opening them for
writes. `--dry-run` performs no writes.

`mcp` is a foreground stdio MCP server. Protocol output is written only to
stdout; ordinary CLI diagnostics must not contaminate that stream. It exposes:

- `memory_recall(query, cwd?, scope?, limit?, maxChars?)`
- `memory_checkpoint(cwd?, memories[])`
- `task_prepare(task, cwd?, profileHints?, capabilities?, maxContextChars?)`
- `task_answer(sessionId, questionId, value, cwd?, capabilities?, maxContextChars?)`

Capability catalogs are request-only metadata and are not persisted. Returned
memory, references, and capability recommendations are advisory and untrusted.

Automatic repository resolution updates only the global path registry; it does
not create `.kiokuko.json` or `AGENTS.md` in the repository. `kiokuko use`
remains the explicit portable-binding path and now defaults to `AGENTS.md`.

## Server commands

```bash
kiokuko serve [--host 127.0.0.1] [--port 0] [--json]
kiokuko server status --json
kiokuko web [--host 127.0.0.1] [--port 4173] [--json]
```

`serve` is foreground and defaults to an available random port. `server status` reads and validates the same-user runtime descriptor but never emits its capability token. `web` uses the same server composition while preserving the legacy UI/route behavior.

## Generic agent HTTP bridge

```bash
kiokuko agent open --workspace <workspace> --client <kind> --task <task> --json
kiokuko agent answer <run-id> --question-id <id> --value <answer> --json
kiokuko agent events <run-id> --input-json FILE|- --json
kiokuko agent checkpoint <run-id> --input-json FILE|- --json
kiokuko agent close <run-id> --input-json FILE|- --json
kiokuko agent feedback <run-id> --input-json FILE|- --json
kiokuko agent promote <run-id> --input-json FILE|- --json
```

These commands discover the service from the runtime descriptor and call authenticated HTTP only. They do not fall back to direct SQLite. If unavailable, they return an explicit service/database error and do not invent an acknowledgement or context result. Token material is never rendered in help, argv, stdout, stderr, or envelopes.

`open` preserves a `needs_answer` response. The caller must show only the returned current question and submit the actual answer. Context appears only after `ready` or bounded `exhausted`. Events/checkpoints/close/feedback consume bounded JSON from a file or stdin rather than long shell arguments.

## HTTP mapping

The bridge maps to `/api/v1/agent/runs`, intake answers, events, checkpoints, close, feedback, and promotions. Every write creates a fresh opaque `Idempotency-Key` unless a key is explicitly supplied in structured input for a retry. Same-key same-body replay is success; same-key different-body is conflict.

## Existing guide and memory paths

`kiokuko guide` remains the compatibility CLI for the shared Akinator service. Existing recall/search/read/record/lifecycle/call/export/import/backup/doctor behavior remains available. The Agent Gateway does not change memory export semantics.

`kiokuko guide context` performs no external skill fetch by default. The caller
must pass `--no-client-skills` to assert that no client skills are available and
enable the allowlisted `mattpocock/skills` reference fallback.

## Web API compatibility

Legacy `/api/health`, `/api/workspaces`, `/api/tags`, and `/api/entries` remain mounted. Agent gateway endpoints use the v1 authenticated contract documented in `agent-gateway.md`. List operations use cursor pagination and hard limits; stored event/memory content is marked untrusted.
