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

Exit codes remain: 0 success, 2 usage, 3 validation, 4 not found, 5 conflict, 6 database/service, 7 security rejection, 8 integrity/doctor, and 9 partial operation failure.

## Database backup

```bash
kiokuko backup --output <path> [--json]
```

`backup` opens the existing database read-only and serializes that exact
connection. It does not initialize or migrate the source. The output parent must
already exist; the output itself is create-only, so a pre-existing file or
symlink is `CONFLICT` and is never overwritten or removed. A missing source is
`NOT_FOUND`. The final output component must be a portable standalone filename:
alternate-stream colons, trailing dots/spaces, and Windows device names are
`VALIDATION_ERROR`. The serialized image is checked for SQLite and foreign-key
integrity before a directory- and file-identity-attested artifact is returned.

## Global client setup and MCP

```bash
kiokuko setup [--clients codex,opencode,claude,hermes] [--command kiokuko] [--skill-discovery off|official|community] [--dry-run] [--no-standard-skills] [--json]
kiokuko mcp
```

`setup` initializes the user-global database and safely merges Codex, OpenCode,
Claude Code, and/or Hermes MCP configuration. Codex, OpenCode, and Claude Code
also use their existing global instruction surfaces; Hermes is profile-scoped
native stdio MCP only and receives no global instruction file, plugin, or hook.
Interactive setup explains that official discovery is reference-only, then asks
whether audited community Skills should also be enabled. The default answer is
no (`official`). A yes answer stores `community` in the selected clients' Kiokuko
MCP environment. Non-interactive and JSON setup never prompt;
`--skill-discovery off|official|community` selects the mode explicitly. When the
flag is omitted, a new MCP entry gets `official` and an existing managed mode is
preserved. An explicitly supplied `KIOKUKO_SKILL_DISCOVERY` environment value is
also honored; the CLI option takes precedence, and any defined value outside
`off|official|community` fails explicitly instead of silently disabling discovery.
Client selection follows this matrix:

| Command | Executables detected on `PATH` | Selected clients |
|---|---|---|
| `kiokuko setup` | `hermes` only | `hermes` |
| `kiokuko setup` | `codex,claude` | `codex,claude` |
| `kiokuko setup` | none | none; initialize only the database |
| `kiokuko setup --clients hermes` | any | `hermes` |
| `kiokuko setup --clients codex,hermes` | any | `codex,hermes` |
| `kiokuko setup --dry-run` | any | the same selection as the corresponding command |

Explicit `--clients` selection always takes precedence. Automatic selection checks
the supported client executables on `PATH`. When the Hermes executable is available,
setup uses its non-shell `hermes config path` result when it is one absolute,
single-line `config.yaml` path; invalid or unavailable output falls back to the
validated `active_profile` marker and then the default `$HOME/.hermes` root.
No-argument setup therefore configures exactly the detected clients. When Hermes is
among them, its configuration is written to the effective Hermes profile; the
user-global Kiokuko database is shared by every selection.

Hermes profile resolution is shared by Linux and macOS:

| State | Effective Hermes home |
|---|---|
| no `HERMES_HOME`, no active profile | `$HOME/.hermes` |
| no `HERMES_HOME`, `active_profile=default` | `$HOME/.hermes` |
| no `HERMES_HOME`, `active_profile=work` | `$HOME/.hermes/profiles/work` |
| `HERMES_HOME=/custom/hermes`, no marker | `/custom/hermes` |
| `HERMES_HOME=/custom/hermes`, `active_profile=work` | `/custom/hermes/profiles/work` |
| `HERMES_HOME=/custom/hermes/profiles/work` | that path itself |

An explicit profile-shaped `HERMES_HOME` takes precedence over the root marker.
Temporary `hermes -p <name>` selections in another process are not inferred.
Invalid markers and missing named profile directories fail with
`VALIDATION_ERROR` without creating the database or files.

Codex's marked `[mcp_servers.kiokuko]` block is managed only in the exact shape
that current `kiokuko setup` writes: one nonempty `command`, `args = ["mcp"]`,
`enabled = true`, and an `env` inline table containing only
`KIOKUKO_SKILL_DISCOVERY=off|official|community`. An absent block is created and
a canonical block can update its command or discovery mode. A legacy block
without `env`, copied markers around a human wrapper, duplicate markers, extra
fields, or any other modified marked block is `CONFLICT` and remains untouched;
setup does not infer ownership from the markers or migrate old block shapes.

Hermes `mcp_servers.kiokuko` is managed only in its canonical shape:

```yaml
command: <scalar string>
args:
  - mcp
env:
  KIOKUKO_SKILL_DISCOVERY: off|official|community
```

An absent entry is created. A managed canonical entry with a different
`command` or discovery mode updates those values and reports `updated`; repeating
the same state reports `unchanged`. A legacy managed entry without `env` is
rejected as `CONFLICT`; it is not silently migrated. The managed marker, comments, line endings, file mode,
top-level values, and other MCP servers are preserved. An unmanaged entry,
noncanonical environment, extra field, or non-`mcp` args remains `CONFLICT`;
malformed YAML or a non-mapping `mcp_servers` remains `VALIDATION_ERROR`.
By default it also places the bundled `kiokuko-ui-design-soul` and
`kiokuko-single-purpose-functions` skills in each selected client's native
user-skill directory. `--no-standard-skills` skips new
placement and updates without deleting a previously installed copy.
Setup installs no client hook or plugin. As a one-way upgrade cleanup, selected
Claude/OpenCode setup removes only the exact retired Claude prompt handler and
byte-exact retired OpenCode guard. A partial, modified, relocated, duplicate, or
unmanaged legacy identity is `CONFLICT`; unrelated settings are preserved.
It computes and validates all file edits before writing, uses per-file atomic
replacement, rolls back already written client files if a later write fails,
rejects symlinks, and is idempotent. Before an existing database is migrated,
`setup` creates and verifies a pre-migration SQLite backup and returns its path as
`databaseBackupPath` in JSON. It rejects databases created by a newer Kiokuko
schema before opening them for writes. `--dry-run` performs no writes.

Standard-skill input is the package's fixed two-skill, five-file manifest; setup
performs no network fetch or dynamic skill discovery. Each managed destination file contains a Kiokuko
marker. A same-name unmarked file causes `CONFLICT` before all writes. Managed
older files are replaced, byte-identical files are `unchanged`, unrelated sibling
files are not touched, and `files[].purpose` is `standard-skill`. JSON setup
results include the effective `standardSkills` boolean.

For Hermes, use `kiokuko setup` when Hermes detection is intended, or
`kiokuko setup --clients hermes` for an explicit selection, then restart Hermes
Agent or start a new session. `/reload-mcp` reloads the MCP registry but is not
sufficient by itself to discover a changed skill. Hermes automatic/model use is
best effort from MCP tool descriptions; its built-in memory and skills remain
separate. Smoke-test the effective profile with `hermes mcp test kiokuko`.

`mcp` is a foreground stdio MCP server. Protocol output is written only to
stdout; ordinary CLI diagnostics must not contaminate that stream. It exposes
only the gated task entry points and lifecycle tools:

- `memory_checkpoint(cwd?, runId?, deliveryId?, outcome?, feedback?, evidence?, memories?)`
- `task_prepare(requestId, task, cwd?, profileHints?, capabilities?, client?, maxContextChars?)`
- `task_answer(sessionId, runId, questionId, value, cwd?, capabilities?, maxContextChars?)`
- `curator_check(cwd?, workspace?, limit?, includeUnready?)`
- `curator_globalize(workspace, entryId, expectedRevision, confirmed=true)`

Run-bound `memory_checkpoint` accepts only an `active` run. Clients must inspect
`nextAction` after every `task_prepare` and `task_answer` response and continue
the `task_answer` loop until intake is `ready` or `exhausted`; Akinator may ask
more than one question. A checkpoint while intake reports `needs_answer` or
`answer_from_evidence_or_ask_user` is a no-op rejection, not a successful
checkpoint. The MCP result is an error with fixed structured guidance:
`code=CHECKPOINT_RUN_NOT_ACTIVE`, `reason` equal to
`run_awaiting_intake_answer` or `run_terminal`, the allowlisted `runStatus`,
`nextAction`, and `retryableAfterStateChange`. A rejected precondition may be
retried only after the indicated state transition; this is not an unchanged
retry. Terminal runs return `nextAction=stop` and are never reopened. Only one
successful terminal checkpoint is allowed per logical request.

Capability catalogs are request-only metadata and are not persisted. Returned
scoped context and capability recommendations are advisory and untrusted.
`task_prepare` and `task_answer` expose scoped `context` as their only
model-facing memory output; the former top-level `memory` and `references`
aliases were removed. They also return `run`, `intake`, and `nextAction`. Every
`task_answer` call requires the exact `run.runId` returned by `task_prepare`;
session-only run lookup is not supported.

Every `task_prepare` call requires a bounded opaque `requestId` chosen by the
client. A new logical user request gets a new ID even when its task text is
identical to an earlier request. The same ID may be reused only for an exact
transport retry: the gateway replays the same run when all bound intake input is
unchanged and returns `CONFLICT` if task, project snapshot, profile hints,
capability catalog, discovery mode, client identity, or normalized context
budget changed. `task_answer` must repeat that same budget. Kiokuko hashes
the ID for idempotency and does not store its raw value. `client.sessionId` is
optional client metadata and is never a substitute for `requestId`.

Clients must inspect `nextAction` after every `task_prepare` and `task_answer`
response before proceeding. When either call produces a ready `build` or
`debug` task with actionable memory context, the response contains a required
`akinator_policy` recommendation for the local `memory-reasoning` capability.
`required_capability_unavailable` is a hard stop when that capability is missing
or catalog availability is unknown: report the boundary and do not continue via
`catalog_similarity`, legacy instructions, external Skill discovery, fetched
skills, or any other fallback. If available, the local `memory-reasoning` Skill
must be read before modifying code; recalled claims that affect the task must be
converted into verified premises, falsifiable invariants, concrete
counterexamples, and regression tests. Availability alone is not compliance.
If the Kiokuko policy cannot be obtained for a non-trivial build/debug request,
stop and report it. Repository-only
continuation for such a request is allowed only after the policy establishes
that no Kiokuko memory was delivered or used.

The explicit `memory recall`, `search`, `read`, and local Web UI surfaces remain
available for human/operator inspection and management. They are not MCP model
tools and are not task-entry fallbacks around `task_prepare` / `task_answer` or
their capability gate. The generic JSON `call` dispatcher likewise rejects its
retired `read`, `search`, and scoped/unscoped `recall` operations.

Automatic repository resolution updates only the global path registry; it does
not create `.kiokuko.json` or `AGENTS.md` in the repository. `kiokuko use`
remains the explicit portable-binding path. A new binding defaults to
`AGENTS.md`; omitting `--agent-file` for an existing binding preserves its
configured path. The selected agent-file parent directory must already exist.
Project bindings reject the reserved `kiokuko_global` repository ID and
`global` workspace.

`--force-rebind` is valid only for an existing binding and must resolve to both
a different repository ID and a different workspace. At least one value must be
supplied; Kiokuko generates the other when it is omitted. A no-op force and a
same-repository workspace change are conflicts: no workspace memory is migrated.
The old repository/workspace identity remains registered and reserved. A forced
rebind replaces only the exact repository/location owner observed during
planning, in one database transaction, and rolls repository-file mutations back
if that compare-and-swap fails.

An explicit `--agent-file` relocation removes only the exact Kiokuko-managed
block at the former path (or deletes a managed-only former file), preserves all
other bytes and its mode, and rolls back owned file changes if the relocation or
registration fails. Parent-directory identity and every affected file are
compare-and-swap checked through completion. With `--no-agent-file`, an existing
managed block at the prospective path must already be byte-exact for the planned
identity and template; stale or foreign blocks are conflicts, including a
forced same-path rebind.

`use` never downgrades a binding, managed block, or registered repository from
a newer version. A future binding/template version, a missing or malformed
managed template-version declaration, and corrupt stored version metadata all
fail explicitly without partial repository-file or location changes. If SQLite
reports failures for both `COMMIT` and the following `ROLLBACK`, the transaction
outcome is explicitly uncertain; `use` preserves its installed repository files
because compensating them could split a database commit from its binding.

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
kiokuko agent open --workspace <workspace> --client <kind> --task <task> --capabilities-json FILE|- [--idempotency-key KEY] --json
kiokuko agent answer <run-id> --question-id <id> --value <answer> --capabilities-json FILE|- [--idempotency-key KEY] --json
kiokuko agent events <run-id> --input-json FILE|- --json
kiokuko agent checkpoint <run-id> --input-json FILE|- --capabilities-json FILE|- --json
kiokuko agent close <run-id> --input-json FILE|- --json
kiokuko agent feedback <run-id> --input-json FILE|- --json
```

These commands discover the service from the runtime descriptor and call authenticated HTTP only. They do not fall back to direct SQLite. If unavailable, they return an explicit service/database error and do not invent an acknowledgement or context result. Token material is never rendered in help, argv, stdout, stderr, or envelopes.

`open` preserves a `needs_answer` response. The caller must show only the returned current question and submit the actual answer. The exact same complete capability catalog must be supplied to `open` and every `answer`; a different catalog is a conflict before intake mutation. Context appears only after `ready` or bounded `exhausted`. For actionable build/debug memory, missing or unknown `memory-reasoning` returns `nextAction: required_capability_unavailable` with `context: null`; no memory delivery is recorded. Non-JSON CLI output includes the unavailable required capability name and availability, such as `memory-reasoning (missing)`, so the stop cannot be mistaken for a generic status. `open` and `answer` accept an explicit bounded `--idempotency-key` for exact unknown-outcome retries; a changed request must use a new key. Events/checkpoints/close/feedback consume bounded JSON from a file or stdin rather than long shell arguments.

## HTTP mapping

The bridge maps to `/api/v1/agent/runs`, intake answers, events, checkpoints, close, and feedback. It does not expose a compatibility alias for the separate promotions endpoint. Every checkpoint that can return task-aware context must include the exact catalog bound at `open`; the server rejects a swapped catalog before context retrieval. The former unbound `/api/v1/context/query` and context-delivery listing endpoints were removed because neither had a safe complete-catalog binding channel. Every write creates a fresh opaque `Idempotency-Key` unless a key is explicitly supplied in structured input for a retry. Same-key same-body replay reuses the stored atomic mutation acknowledgement without repeating the write; same-key different-body is conflict. Capability gating and context retrieval are post-commit and are re-evaluated against current retrievable revisions and feedback, so an exact retry can return different enriched context or a new hard-stop state while retaining the same mutation acknowledgement.

## Existing guide and memory paths

`kiokuko guide` retains intake-only `start` and `answer` commands. Direct
human/operator recall, search, and read commands remain management-only. The legacy
`guide context` command and `guide_context` JSON operation were removed because
they returned task-aware memory without the capability hard gate. Use
`task_prepare` / `task_answer` or the generic Agent bridge instead. Normal
`task_prepare` uses `official` discovery by default; set
`KIOKUKO_SKILL_DISCOVERY=off` to disable it or `community` to broaden it. The
explicit `kiokuko skills find` command uses the same provider-backed search.

## External skills

```bash
kiokuko skills find <catalog-query> [--owner <catalog-owner>] [--official-only] [--json]
kiokuko skills import <owner>/<repository>/<skill> [--json]
kiokuko skills list [--state <state>] [--json]
kiokuko skills show <skill-id|owner/repository/skill> [--json]
kiokuko skills refresh [<skill-id|owner/repository/skill>] [--json]
kiokuko skills disable <skill-id|owner/repository/skill> [--json]
kiokuko skills enable <skill-id|owner/repository/skill> [--json]
kiokuko skills prune-cache [--json]
```

`find` is read-only and accepts only the finite technology/query and matching
owner values in Kiokuko's reviewed catalog; it is not a general free-text
search surface. Manual `import` is create-only and accepts only an exact
reviewed-catalog identity; use `refresh` for an already imported identity. Both
operations revalidate the current commit-pinned GitHub snapshot before storing
it as untrusted reference data. If authenticated v1 search rejects its
credential with the documented 401 authentication response, `find` and
automatic discovery retry that query once through the Compatibility Provider;
the two providers retain separate cache identities.
Lifecycle commands accept either the source-type-prefixed internal ID or the
documented `owner/repository/skill` identity. Provider adapters do not create
separate durable Skill identities.
Refreshing a noncatalog community identity requires a fresh passed provider
audit. A stored historical audit status does not authorize a new snapshot.
`disable` only deactivates retrieval mappings; `enable` accepts only a
disabled skill with a verified snapshot. JSON responses use the same
`{apiVersion, ok, operation, data}` success envelope as the other CLI groups.
`prune-cache` fully validates and then atomically prunes the provider-search,
source-failure, and provider-audit failure caches. It reports per-cache and
total counts; any malformed row aborts before deleting anything.

## Web API compatibility

Legacy `/api/health`, `/api/workspaces`, `/api/tags`, and `/api/entries` remain mounted. The UI Curator flow uses `GET /api/curator/candidates?limit=...` to return curation candidates across all project workspaces; the optional `workspace=...` filter remains available for compatibility. Each candidate carries its source workspace. The UI sends a revision-checked `POST /api/curator/globalize?workspace=...` for each explicitly selected candidate. External Skill management uses cursor-paginated `GET /api/skills?state=&limit=&cursor=`, bounded `GET /api/skills/:id`, and same-origin/session-protected `POST /api/skills/:id/refresh|disable|enable`; only imported/disabled lifecycle states expose disable/enable transitions. Agent gateway endpoints use the v1 authenticated contract documented in `agent-gateway.md`. Paginated list operations use opaque cursors and hard limits; stored event/memory content is marked untrusted.
