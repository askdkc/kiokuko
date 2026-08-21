# Client compatibility policy

Status: global MCP integration for Codex, OpenCode, and Claude Code; lifecycle hooks remain disabled.

| Client | Global MCP registration | Global instructions | Automatic-use level | Hooks/plugins |
|---|---|---|---|---|
| Codex | managed table in `~/.codex/config.toml` (or `$CODEX_HOME`) | managed block in global `AGENTS.md` | instruction-driven, best effort | not installed |
| OpenCode | managed `mcp.kiokuko` property in global `opencode.json`/`opencode.jsonc` | managed block in global `AGENTS.md` | instructions plus bounded enforcement | managed `plugins/kiokuko-loop-guard.js` |
| Claude Code | managed `mcpServers.kiokuko` property in `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) | managed block in global `CLAUDE.md` | instruction-driven, best effort | not installed |
| Other MCP clients | manual `kiokuko mcp` stdio registration | client-specific | client-specific | none |

Codex's current official documentation supports stdio MCP servers and global
configuration. OpenCode's current official documentation supports local MCP
commands and global rules. Claude Code supports user-scoped stdio MCP servers,
global `CLAUDE.md`, and auto-discovered skills. `kiokuko setup` uses the MCP and
instruction surfaces, but does not install client skills:

- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
- [OpenCode rules](https://opencode.ai/docs/rules/)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)
- [Claude Code MCP servers](https://code.claude.com/docs/en/mcp)
- [Claude Code memory and CLAUDE.md](https://code.claude.com/docs/en/memory)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)

## Guarantees and non-guarantees

Setup guarantees safe, repeatable configuration merging and makes the four MCP
tools available globally after the client reloads its configuration. For
OpenCode it also installs a dependency-free local guard through the documented
global plugin directory. The guard caps visible agents at 12 steps, rejects a
second `task_prepare` or `memory_checkpoint` in one user turn, rejects tool use
after a completed checkpoint, and blocks a fourth identical call or the next
call after three identical read-only discovery results. State consists only of
in-memory counters and SHA-256 fingerprints and is cleared on the next user
message or terminal session event. Global
instructions request `task_prepare` before non-trivial work, grounded
`task_answer` calls when intake fields are missing, and checkpointing after
substantial verified work.

No supported client guarantees that a model will call an available tool for every
prompt. Therefore “automatic” means no per-repository install and no manual CLI
lifecycle after one-time setup; it does not mean Kiokuko intercepts every
prompt or response.

Kiokuko does not install Codex or Claude hooks. The OpenCode loop guard is the
only installed plugin; it observes tool names, arguments, and results only long
enough to fingerprint them in memory and never logs or persists those values.
Broader lifecycle capture remains out of scope because it would add versioned
event-shape dependencies and transcript/privacy risk.

`task_prepare` can accept an ephemeral catalog of skill and MCP-tool names from
the calling client. Kiokuko matches Akinator policy recommendations and task
terms against that catalog, but cannot enumerate another MCP server or a
client's private skill registry by itself. A result therefore distinguishes
`available`, `missing`, and `unknown`; it never treats a fetched `SKILL.md` as
installed or executable. The `mattpocock/skills` reference fallback is enabled
only when the client explicitly supplies a catalog containing zero skills.
Omitted catalogs and catalogs containing any skill disable it.

## Scope boundary

The stdio MCP server calls Kiokuko's memory services directly. It never exposes
the SQLite file as a tool. Recall is limited to the resolved current repository
and/or the reserved global workspace; it never searches unrelated project
workspaces. Writes are candidate-only, untrusted, bounded, content-hash
idempotent, audited, and passed through secret detection.

The older generic Agent Gateway remains available for explicit execution-ledger
workflows. It is no longer required for ordinary recall/checkpoint use.
