# CLI contract

Existing memory commands and their JSON envelopes/exit codes remain stable. Machine-readable commands write exactly one JSON object to stdout; diagnostics go to stderr.

```bash
kiokuko version
```

`version` prints the installed package version. The existing `--version` option remains available as an equivalent shorthand.

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
kiokuko setup [--clients codex,opencode,claude,hermes] [--command kiokuko] [--dry-run] [--no-standard-skills] [--opencode-capture off|minimal|standard] [--opencode-mode advisory|strict] [--json]
kiokuko mcp
```

`setup` initializes the user-global database and safely merges Codex, OpenCode,
Claude Code, and/or Hermes MCP configuration. Codex, OpenCode, and Claude Code
also use their existing global instruction surfaces; Hermes is profile-scoped
native stdio MCP only and receives no global instruction file, plugin, or hook.
By default it also places the bundled `kiokuko-ui-design-soul` skill in each
selected client's native user-skill directory. `--no-standard-skills` skips new
placement and updates without deleting a previously installed copy.
It computes and validates all file edits before writing, uses per-file atomic
replacement, rolls back already written client files if a later write fails,
rejects symlinks, and is idempotent. Before an existing database is migrated,
`setup` creates and verifies a pre-migration SQLite backup and returns its path as
`databaseBackupPath` in JSON. It rejects databases created by a newer Kiokuko
schema before opening them for writes. `--dry-run` performs no writes.

Standard-skill input is the package's fixed two-file manifest; setup performs no
network fetch or HIG scraping. Each managed destination file contains a Kiokuko
marker. A same-name unmarked file causes `CONFLICT` before all writes. Managed
older files are replaced, byte-identical files are `unchanged`, unrelated sibling
files are not touched, and `files[].purpose` is `standard-skill`. JSON setup
results include the effective `standardSkills` boolean.

For Hermes, use `kiokuko setup --clients hermes`, then restart Hermes Agent or
start a new session. `/reload-mcp` reloads the MCP registry but is not sufficient
by itself to discover a changed skill. Hermes automatic/model use is best effort from MCP tool
descriptions; its built-in memory and skills remain separate. Smoke-test
the effective profile with `hermes mcp test kiokuko`.

`mcp` is a foreground stdio MCP server. Protocol output is written only to
stdout; ordinary CLI diagnostics must not contaminate that stream. It exposes:

- `memory_recall(query, cwd?, scope?, limit?, maxChars?)`
- `memory_checkpoint(cwd?, runId?, deliveryId?, outcome?, feedback?, evidence?, memories?)`
- `task_prepare(task, cwd?, profileHints?, capabilities?, client?, maxContextChars?)`
- `task_answer(sessionId, questionId, value, cwd?, runId?, capabilities?, maxContextChars?)`
- `curator_check(cwd?, workspace?, limit?, includeUnready?)`
- `curator_globalize(workspace, entryId, expectedRevision, confirmed=true)`

Capability catalogs are request-only metadata and are not persisted. Returned
memory, references, context deliveries, and capability recommendations are
advisory and untrusted. `task_prepare` returns additive `run` and `context`
objects while preserving the legacy intake, memory, references, and nextAction
fields.

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

## Curator

```bash
kiokuko curator [--workspace <name>] [--cwd <path>] [--entry-id <id>] [--limit <number>] [--skill-ready-only] [--yes] [--json]
```

The command scores project candidate entries for cross-project reuse and
deterministically regenerates a portable draft. Project identifiers and paths
are generalized, while purpose, procedure, structured applicability, and a
verification reminder are retained. The command shows the skill name, a
three-line overview, the full draft, qualified-hit counts, independent-run and
workspace counts, and the abstraction-to-action silo score. Interactive mode asks for explicit
confirmation before creating a `global` candidate from that draft. `--json` is
read-only; `--yes` is an explicit batch confirmation option. Globalization is
revision checked and stores the source workspace, source revision, and draft
generator version in provenance/reference metadata. The result remains a
candidate/untrusted entry until normal promotion. No external LLM is called.
`--skill-ready-only` requires at least two qualified independent runs, high silo
completeness, and portability evidence. Recall/search frequency is not a hit.

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

Legacy `/api/health`, `/api/workspaces`, `/api/tags`, and `/api/entries` remain mounted. The UI Curator flow uses `GET /api/curator/candidates?limit=...` to return curation candidates across all project workspaces; the optional `workspace=...` filter remains available for compatibility. Each candidate carries its source workspace. The UI sends a revision-checked `POST /api/curator/globalize?workspace=...` for each explicitly selected candidate. Agent gateway endpoints use the v1 authenticated contract documented in `agent-gateway.md`. List operations use cursor pagination and hard limits; stored event/memory content is marked untrusted.
