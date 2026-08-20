# Client compatibility policy

Status: core/generic integration contract; named client event bridges remain unverified until versioned clean-room evidence exists.

Kiokuko's core is client-neutral HTTP/JSON. `AGENT.md` (singular) is the one canonical generated instruction body required by this project. Default `kiokuko use` does not create or modify `AGENTS.md`, `CLAUDE.md`, OpenCode rules, plugins, or hooks.

| Client | Official instruction documentation previously located | Singular `AGENT.md` auto-load | Shell/generic CLI path | Lifecycle/tool/file/approval event coverage |
|---|---|---|---|---|
| Codex | https://learn.chatgpt.com/docs/agent-configuration/agents-md | Not established; plural convention must not be silently mapped | Generic shell path only until clean-room smoke | `declared`/`unavailable`; no complete bridge claim |
| Claude Code | https://code.claude.com/docs/en/memory | Not established | Generic shell path only until clean-room smoke | `declared`/`unavailable`; no complete bridge claim |
| OpenCode | https://opencode.ai/docs/rules/ | Not established | Generic shell path only until clean-room smoke | `declared`/`unavailable`; no complete bridge claim |
| dsh | No verified official product identity/specification | Unverified | Unverified | Unverified; unsupported |

Documentation reachability alone is not event compatibility evidence. Before a named bridge is described as supported, Task 8 must pin the exact product/version, verify official instruction/tool/hook APIs, capture sanitized real event shape and ordering in a clean room, and assign each category `complete`, `best_effort`, `declared`, or `unavailable`.

## Integration layers

1. **Generic CLI (core acceptance path):** any shell-capable agent can open/answer/events/checkpoint/close/feedback through the Kiokuko HTTP client. Generic runs claim only declared/unavailable event categories.
2. **Common tool protocol:** may be added as a thin stdio/tool-to-HTTP translator only after current official support and clean-room operation are demonstrated across the intended clients.
3. **Optional client hook/plugin:** isolated under `integrations/<client>/`, version-pinned, disabled by default, dry-run first, and explicit opt-in before editing a client file. It sends normalized events to HTTP and never imports database internals.

Adapters never duplicate the canonical `AGENT.md` body. They may only point an officially recognized instruction mechanism at that canonical file or expose thin HTTP tools. Unsupported categories are not inferred from neighboring events. If a hook cannot observe an approval or filesystem mutation, coverage records that limitation and the UI must display it.

No provider reverse proxy is part of client compatibility v1.
