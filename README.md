# Kiokuko

Kiokuko is model-agnostic external memory for AI coding agents. One global npm
installation stores structured memory in the current user's SQLite database and
exposes high-level recall/checkpoint tools to Codex and OpenCode over stdio MCP.

## Install and enable globally

```bash
npm install --global kiokuko
kiokuko setup
```

Restart Codex and OpenCode after setup. From then on, their global `AGENTS.md`
instructs the agent to call Kiokuko before non-trivial work and after durable
work, and their global config starts `kiokuko mcp` when the tools are needed.

`setup` is explicit and idempotent. npm `postinstall` never edits AI-client
configuration. Existing TOML/JSONC settings, comments, instruction content,
line endings, and file modes are preserved; Kiokuko owns only its managed
sections.

```bash
# Preview exact target files without writing anything
kiokuko setup --dry-run --json

# Configure only one client
kiokuko setup --clients codex
kiokuko setup --clients opencode

# Use an absolute executable path if the client process does not inherit npm's PATH
kiokuko setup --command /absolute/path/to/kiokuko
```

The setup targets are:

| Client | MCP config | Global instructions |
|---|---|---|
| Codex | `$CODEX_HOME/config.toml` or `~/.codex/config.toml` | `$CODEX_HOME/AGENTS.md` or `~/.codex/AGENTS.md` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json` or `~/.config/opencode/opencode.json` | the adjacent `AGENTS.md` |

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

- `memory_recall`: read bounded project/global context, always marked untrusted.
- `memory_checkpoint`: store bounded durable entries as `candidate` and
  `untrusted`; secret-like content is rejected.

This is instruction-driven automatic use, not prompt interception. Codex and
OpenCode can still choose not to call a tool on a particular turn. Kiokuko does
not install hooks, capture full transcripts, or silently promote memory to
verified status.

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

For non-trivial work, `guide` asks only for missing high-value fields such as
the task type, target, and success condition. It then selects local memory by
query and Bot-purpose tags:

```bash
kiokuko guide start "Implement the API change and add tests" \
  --workspace <workspace> --json
kiokuko guide answer <session-id> --workspace <workspace> \
  --question-id target --value src/api.ts --json
kiokuko guide answer <session-id> --workspace <workspace> \
  --question-id expected --value "All tests pass" --json
kiokuko guide context <session-id> --workspace <workspace> --json
```

If local retrieval produces no relevant entries, `guide context` can fetch the
current `main` tree from only these allowlisted public repositories and store
the selected Markdown skills or references as `candidate` entries:

- https://github.com/NousResearch/hermes-agent
- https://github.com/obra/superpowers

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
