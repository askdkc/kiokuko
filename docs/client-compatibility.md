# Client compatibility policy

Status: global MCP integration for Codex and OpenCode; lifecycle hooks remain disabled.

| Client | Global MCP registration | Global instructions | Automatic-use level | Hooks/plugins |
|---|---|---|---|---|
| Codex | managed table in `~/.codex/config.toml` (or `$CODEX_HOME`) | managed block in global `AGENTS.md` | instruction-driven, best effort | not installed |
| OpenCode | managed `mcp.kiokuko` property in global `opencode.json`/`opencode.jsonc` | managed block in global `AGENTS.md` | instruction-driven, best effort | not installed |
| Other MCP clients | manual `kiokuko mcp` stdio registration | client-specific | client-specific | none |

Codex's current official documentation supports stdio MCP servers and global
configuration. OpenCode's current official documentation supports local MCP
commands and global rules. `kiokuko setup` uses those supported surfaces:

- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)
- [Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
- [OpenCode rules](https://opencode.ai/docs/rules/)
- [OpenCode plugins](https://opencode.ai/docs/plugins/)

## Guarantees and non-guarantees

Setup guarantees safe, repeatable configuration merging and makes the two MCP
tools available globally after the client reloads its configuration. Global
instructions request recall before non-trivial work and checkpointing after
substantial verified work.

Neither client guarantees that a model will call an available tool for every
prompt. Therefore “automatic” means no per-repository install and no manual CLI
lifecycle after one-time setup; it does not mean Kiokuko intercepts every
prompt or response.

Kiokuko does not install Codex hooks or OpenCode plugins by default. Those
surfaces can observe more lifecycle data, but they add trust prompts, versioned
event-shape dependencies, and transcript/privacy risk. Adding them later must
be a separate explicit opt-in with clean-room fixtures and bounded sanitized
payloads.

## Scope boundary

The stdio MCP server calls Kiokuko's memory services directly. It never exposes
the SQLite file as a tool. Recall is limited to the resolved current repository
and/or the reserved global workspace; it never searches unrelated project
workspaces. Writes are candidate-only, untrusted, bounded, content-hash
idempotent, audited, and passed through secret detection.

The older generic Agent Gateway remains available for explicit execution-ledger
workflows. It is no longer required for ordinary recall/checkpoint use.
