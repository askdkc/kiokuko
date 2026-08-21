# Kiokuko

English | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

Kiokuko(記憶庫) is model-agnostic external memory for AI coding agents. One global npm
installation stores structured memory in the current user's SQLite database and
exposes guided task preparation plus recall/checkpoint tools to Codex, OpenCode,
and Claude Code over stdio MCP.

The name **Kiokuko** comes from the Japanese **記憶庫**: **記憶** means
"memory," and **庫** means "storehouse," so the name describes a place for
storing memories.

## Install and enable globally

Node.js 24 or newer is required.

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

The npm package name is `@askdkc/kiokuko`; the installed CLI command remains
`kiokuko`.

Restart Codex, OpenCode, and Claude Code after setup. From then on, their global
instructions tell the agent to call Kiokuko before non-trivial work and after
durable work, and their global config starts `kiokuko mcp` when needed.

`setup` is explicit and idempotent. npm `postinstall` never edits AI-client
configuration. Existing TOML/JSON/JSONC settings, comments, instruction content,
line endings, and file modes are preserved; Kiokuko owns only its managed
sections.

```bash
# Preview exact target files without writing anything
kiokuko setup --dry-run --json

# Configure only one client
kiokuko setup --clients codex
kiokuko setup --clients opencode
kiokuko setup --clients claude

# Use an absolute executable path if the client process does not inherit npm's PATH
kiokuko setup --command /absolute/path/to/kiokuko
```

The setup targets are:

| Client | MCP config | Global instructions |
|---|---|---|
| Codex | `$CODEX_HOME/config.toml` or `~/.codex/config.toml` | `$CODEX_HOME/AGENTS.md` or `~/.codex/AGENTS.md` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json` or `~/.config/opencode/opencode.json` | the adjacent `AGENTS.md` |
| Claude Code | `$CLAUDE_CONFIG_DIR/.claude.json` or `~/.claude.json` | `$CLAUDE_CONFIG_DIR/CLAUDE.md` or `~/.claude/CLAUDE.md` |

If an OpenCode `opencode.jsonc` already exists, Kiokuko updates that file and
preserves comments. If Codex already has an unmanaged
`[mcp_servers.kiokuko]` table, setup refuses to guess which configuration to
overwrite.

## Memory scope

The database is global to the OS user, but ordinary recall is not a global
full-database search:

- `project` memory is resolved automatically from `.kiokuko.json`, the known
  canonical path, or the Git remote. Another project's memory is excluded.
- `global` memory is reserved for genuinely cross-project preferences and
  lessons.
- default `auto` recall returns only the current project plus global memory.
- a repository without a remote gets a stable path-derived identity. Kiokuko
  does not write anything into the repository during automatic resolution.

The MCP surface is deliberately small:

- `task_prepare`: run the Akinator intake, recall bounded memory and references,
  and match required skills/MCP tools against the capability names supplied by
  the current client.
- `task_answer`: continue an intake only with an answer grounded in the user
  request or verified repository evidence.
- `memory_recall`: read bounded project/global context, always marked untrusted.
- `memory_checkpoint`: store bounded durable entries as `candidate` and
  `untrusted`; secret-like content is rejected.

This is instruction-driven automatic use, not prompt interception. Codex,
OpenCode, and Claude Code can still choose not to call a tool on a particular
turn. Kiokuko does not install hooks, capture full transcripts, install fetched
skills, or silently promote memory to verified status.

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
That tool asks only for missing high-value fields such as the task type, target,
and success condition, then selects local memory by query and Bot-purpose tags.
If the client supplies its currently available skill and MCP-tool names, the
result also identifies matching capabilities and clearly distinguishes
available, missing, and unknown skills. The catalog is ephemeral and is not
stored. The CLI `guide` commands expose the same intake for manual use:

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

Start a loopback-only HTTP server to browse memory entries by Bot purpose,
memory type, and cross-cutting tags, and edit candidate entries from the browser:

```bash
kiokuko web
# open http://127.0.0.1:4173
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
