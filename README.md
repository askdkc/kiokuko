# Kiokuko

English | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

Kiokuko(記憶庫) is model-agnostic external memory for AI coding agents. One global npm
installation stores structured memory in the current user's SQLite database and
exposes guided task preparation plus recall/checkpoint tools to Codex, OpenCode,
Claude Code, and Hermes Agent over native stdio MCP.

The name **Kiokuko** comes from the Japanese **記憶庫**: **記憶** means
"memory," and **庫** means "storehouse," so the name describes a place for
storing memories.

## Install and enable globally

Node.js 24 or newer is required.

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

The no-argument command checks `PATH` for each supported client executable
(`codex`, `opencode`, `claude`, and `hermes`). In an interactive terminal,
setup displays a checked-choice list with detected clients preselected;
pressing Enter accepts that selection. You can enter client names or numbers
separated by commas to change it, or `none` to configure no clients. In
`--json` and non-TTY runs, setup remains non-interactive and configures only
detected clients. When `hermes` is detected, Kiokuko asks it for the active
profile with `hermes config path`; otherwise it uses the valid `active_profile`
marker or the default `$HOME/.hermes` root. If no supported client is detected
and no interactive selection is made, setup initializes the database but writes
no client configuration. Use `--clients` to configure a client explicitly;
explicit selection always takes precedence.

The npm package name is `@askdkc/kiokuko`; the installed CLI command remains
`kiokuko`.

Restart the clients reported by setup. Hermes can
reload the MCP registry with `/reload-mcp`, but a restart or new session is still
required to discover an updated standard skill; smoke-test the active Hermes
profile with `hermes mcp test kiokuko`. Codex, OpenCode, and Claude Code use their existing
instruction surfaces to request Kiokuko before non-trivial work and after durable
work. Hermes uses its profile-scoped native MCP registration only: Kiokuko does not
create a global instruction file, Hermes plugin, or Hermes hook.

`setup` is explicit and idempotent. npm `postinstall` never edits AI-client
configuration. Existing TOML/JSON/JSONC/YAML settings, comments, instruction content, line endings,
and file modes are preserved; Kiokuko owns only its managed sections. By default,
setup also installs the bundled `kiokuko-ui-design-soul` skill from a fixed local
manifest. It performs no setup-time download or HIG scraping.

When an existing database has pending migrations, setup first creates and
integrity-checks a backup in the adjacent `backups/` directory under the current
user's data directory. A
database written by a newer Kiokuko version is rejected without modification.

```bash
# Preview exact target files without writing anything
kiokuko setup --dry-run --json

# Configure only one client
kiokuko setup --clients codex
kiokuko setup --clients opencode
kiokuko setup --clients claude
kiokuko setup --clients hermes

# Use an absolute executable path if the client process does not inherit npm's PATH
kiokuko setup --command /absolute/path/to/kiokuko

# Skip new standard-skill placement; an existing managed copy is not deleted
kiokuko setup --no-standard-skills
```

Hermes setup is profile-scoped. A named profile such as
`$HOME/.hermes/profiles/work/config.yaml` receives the MCP config and standard
skill; the root and inactive profiles are not modified. A temporary
`hermes -p <name>` selection in another process is not inferred by setup. To
target a named profile explicitly, pass its profile directory as
`HERMES_HOME`:

```bash
HERMES_HOME="$HOME/.hermes/profiles/work" kiokuko setup --clients hermes
```

If a desktop process cannot find `kiokuko` through its `PATH`, migrate the
managed command to an absolute executable path. Do not pass an empty result
from `command -v`:

```bash
KIOKUKO_BIN="$(command -v kiokuko)"
test -n "$KIOKUKO_BIN" && test -x "$KIOKUKO_BIN" || {
  echo "kiokuko executable not found" >&2
  exit 1
}
kiokuko setup --clients hermes --command "$KIOKUKO_BIN"
```

The setup targets are:

| Client | MCP config | Global instructions | Runtime guard | Standard skill |
|---|---|---|---|---|
| Codex | `$CODEX_HOME/config.toml` or `~/.codex/config.toml` | `$CODEX_HOME/AGENTS.md` or `~/.codex/AGENTS.md` | — | `~/.agents/skills/kiokuko-ui-design-soul` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json` or `~/.config/opencode/opencode.json` | the adjacent `AGENTS.md` | `plugins/kiokuko-loop-guard.js` | global config `skills/kiokuko-ui-design-soul` |
| Claude Code | `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json` | `$CLAUDE_CONFIG_DIR/CLAUDE.md` or `~/.claude/CLAUDE.md` | — | Claude config `skills/kiokuko-ui-design-soul` |
| Hermes Agent | effective profile `config.yaml` under `$HERMES_HOME`, `$HOME/.hermes`, or `%LOCALAPPDATA%/hermes` | none | none | effective profile `skills/kiokuko-ui-design-soul` |

Hermes is configured as a profile-scoped native stdio MCP server with `command: kiokuko` and `args: [mcp]`. A managed canonical entry can have its `command` migrated with `--command`; `args`, comments, and other servers are preserved. Unmanaged entries, extra fields, and non-`mcp` args remain conflicts. `setup` follows `hermes config path` when available, then a valid sticky `active_profile` when `HERMES_HOME` is a root, and never silently falls back from a missing named profile.

If an OpenCode `opencode.jsonc` already exists, Kiokuko updates that file and
preserves comments. If Codex already has an unmanaged
`[mcp_servers.kiokuko]` table, setup refuses to guess which configuration to
overwrite. The managed OpenCode guard caps visible agents at 12 steps, permits
`task_prepare` and `memory_checkpoint` only once per user request, closes tool
use after a checkpoint, and stops repeated calls or read-only discovery results
after three unchanged iterations. It keeps its counters and fingerprints in
process memory only.

Each bundled skill file carries a Kiokuko management marker. Setup replaces only
the fixed known files, reports exact matches as unchanged, and leaves unrelated
sibling files alone. If a same-name skill file lacks the marker, setup stops with
`CONFLICT` before any file or database write.

## Memory scope

The database is global to the OS user, but ordinary recall is not a global
full-database search:

- `project` memory is resolved automatically from `.kiokuko.json`, the known
  canonical path, or the Git remote. Another project's memory is excluded.
- `global` memory is reserved for genuinely cross-project preferences and
  lessons. New global lessons should include applicability (language,
  framework, runtime, database, tool, or platform) or an explicit portable
  reason; unscoped global candidates are penalized during task preparation.
- default `auto` recall returns only the current project plus global memory.
- a repository without a remote gets a stable path-derived identity. Kiokuko
  does not write anything into the repository during automatic resolution.

The MCP surface is deliberately small:

- `task_prepare`: once per user request, run the Akinator intake, open a
  lightweight execution-ledger run, and return one bounded ranked context
  delivery from the current project plus applicable global memory. The run and
  delivery IDs are returned for the final checkpoint.
- `task_answer`: continue an intake only with an answer grounded in the user
  request or verified repository evidence.
- `memory_recall`: read bounded project/global context, always marked untrusted.
- `curator_check`: before the final checkpoint, return only skill-ready
  candidates by default. A qualified hit is a completed, actionable Akinator
  path with fresh verification or a passing test; retrieval frequency is never
  counted.
- `curator_globalize`: store one revision-checked regenerated draft only after
  the user explicitly approves the displayed skill name and three-line overview.
- `memory_checkpoint`: once at the end of a user request, atomically store
  candidate memory, bounded evidence, context feedback, ledger links, and the
  terminal run outcome. It also records the Akinator narrowing path for each
  proposed memory. Secret-like content, absolute paths, raw output, and
  unbounded evidence are rejected.

Search uses additive hybrid lanes: exact structured signals, word FTS5,
trigram substring FTS5, bounded literal fallback, and exact tags. Existing
word-search data remains intact across migrations. Use
`kiokuko setup --clients opencode --opencode-capture minimal|standard` to opt
into in-memory OpenCode evidence metadata, and add
`--opencode-mode strict` only when mutating tools must follow `task_prepare`.

## Curator

`kiokuko curator` finds project candidate memories that look reusable across
projects. It deterministically removes project identifiers and paths, then
regenerates a portable draft with purpose, procedure, applicability, and
verification sections. It prints the skill name, a three-line overview, and
the full draft before asking for explicit confirmation. Curator separately
reports qualified hits, independent runs, workspaces, and abstraction-to-action
silo completeness. Use `--skill-ready-only` for the filtered periodic-prompt
set, `--json` to inspect candidates without changing memory, `--yes` only for
an explicit batch confirmation, or `--entry-id <id>` to review one entry:

```bash
kiokuko curator
kiokuko curator --json
kiokuko curator --skill-ready-only
kiokuko curator --entry-id <entry-id>
```

The Web UI has a Curator button that lists curation candidates across all
project workspaces. Each candidate keeps its source workspace, can be selected
or skipped in the checklist, and selected candidates are added in one explicit
user action. The generated draft—not the original project-specific body—is
stored as the Global entry. The generator is local and deterministic; it does
not call an external LLM. Globalized entries retain source workspace, source
revision, and provenance, and remain untrusted candidates until separately
promoted.

This is instruction-driven automatic use for clients with instruction surfaces,
not prompt interception. Codex, OpenCode, Claude Code, and Hermes Agent can still
choose not to call a tool on a particular turn; Hermes automatic/model use is best
effort from MCP tool descriptions. Hermes's built-in memory and skills
remain separate. Kiokuko does not capture full transcripts or install fetched skills,
create a Hermes global instruction file, or silently promote memory to verified
status. The bounded local loop guard described above is the only plugin installed
for OpenCode; the bundled standard skill is a native client skill, not a plugin.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## Development usage

```bash
npm exec -- tsx src/bin/kiokuko.ts setup --dry-run --json
npm exec -- tsx src/bin/kiokuko.ts mcp
```

`kiokuko use` remains optional for a portable explicit binding. It creates
`.kiokuko.json` and a managed block in `AGENTS.md`; normal MCP use no longer
requires it.

## Akinator-style knowledge intake

For non-trivial work, the installed agent instructions call `task_prepare`.
The Akinator is an active reasoning guide, not a popularity counter or a fixed
profile form. It starts with competing action families, uses each question to
discriminate among or concretize them, and returns an abstraction-to-action silo:
intent, action family, target, success state, selected action, verification, and
stop conditions. It asks only for missing high-value fields such as the task
type, target, and observable success condition, then selects local memory by
query and role and purpose tags.
If the client supplies its currently available skill and MCP-tool names, the
result also identifies matching capabilities and clearly distinguishes
available, missing, and unknown skills. The catalog is ephemeral and is not
stored. The CLI `guide` commands expose the same intake for manual use:

For tasks containing concrete UI vocabulary such as UI, UX, frontend, screen,
SwiftUI, or accessibility, `task_prepare` explicitly recommends
`kiokuko-ui-design-soul` when it is present in the client catalog. Generic
`design`, backend-only work, and image-only generation do not trigger it.

```bash
kiokuko guide start "Implement the API change and add tests" \
  --workspace <workspace> --json
kiokuko guide answer <session-id> --workspace <workspace> \
  --question-id target --value src/api.ts --json
kiokuko guide answer <session-id> --workspace <workspace> \
  --question-id expected --value "All tests pass" --json
kiokuko guide context <session-id> --workspace <workspace> --json
```

If local retrieval produces no relevant entries and the client explicitly
reports zero available skills, `task_prepare` can fetch the current `main` tree
from the single allowlisted fallback repository:

- https://github.com/mattpocock/skills

An omitted capability catalog means “unknown,” not zero, and disables this
fallback. A catalog containing any skill also disables it. Manual CLI use must
state the same condition explicitly with `guide context ... --no-client-skills`.
Skills marked `disable-model-invocation: true` are excluded from automatic
selection.

Each imported entry records its repository, commit SHA, and source path. It is
untrusted reference material and is never auto-promoted to `verified` or
executed as a command. Repeated sync is content-hash idempotent.

## Local web UI

Start a loopback-only HTTP server to browse memory entries by role and purpose,
memory type, and cross-cutting tags, and edit candidate entries from the browser:

```bash
kiokuko web
# open http://127.0.0.1:4173
```

For local development from a source checkout, build the package and start the
compiled Web UI explicitly:

```bash
npm run build
node dist/bin/kiokuko.js web --host 127.0.0.1 --port 4173
```

The UI supports English, Japanese, Simplified Chinese, and Korean. It uses the
browser language on first use, persists an explicit language selection in the
browser, and accepts `?lang=en`, `?lang=ja`, `?lang=zh-CN`, or `?lang=ko` as an
override.

Use `--port 0` to select an available port, or `--json` to print the selected
URL as JSON. The web UI does not expose the server on non-loopback interfaces.
Verified and superseded entries are read-only; editing a candidate uses an
optimistic revision check and preserves the audit trail.
Tags such as `bot:researcher`, `bot:builder`, and `bot:reviewer` can be used as
cross-genre filters. Clicking a tag in an entry or in the sidebar shows every
matching entry regardless of its memory type.

Memory entries are untrusted stored data. Verify current files and runtime
state before relying on historical entries. Never store passwords, API keys,
tokens, private keys, or session cookies.

This repository is not published automatically. `npm publish`, commits, and
pushes require explicit user authorization.
