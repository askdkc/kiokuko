# Client compatibility policy

Status: global MCP integration for Codex, OpenCode, Claude Code, and profile-scoped Hermes Agent.

| Client | Global MCP registration | Global instructions | Managed standard skills | Hooks/plugins |
|---|---|---|---|---|
| Codex | managed table in `~/.codex/config.toml` (or `$CODEX_HOME`) | managed block in global `AGENTS.md` | seven bundled skills below `~/.agents/skills/` | none |
| OpenCode | managed `mcp.kiokuko` property in global `opencode.json`/`opencode.jsonc` | managed block in global `AGENTS.md` | seven bundled skills below global config `skills/` | none |
| Claude Code | managed `mcpServers.kiokuko` property in `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) | managed block in global `CLAUDE.md` | seven bundled skills below Claude config `skills/` | none |
| Hermes Agent | managed `mcp_servers.kiokuko` in the effective profile `config.yaml` | none | seven bundled skills below effective profile `skills/` | none |
| Other MCP clients | manual `kiokuko mcp` stdio registration | client-specific | not installed | none |

OpenCode global configuration follows XDG paths on every platform:
`$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode` when unset. On Windows,
`~` resolves from `%USERPROFILE%`, falling back to `%HOME%`; `%APPDATA%` and
`%LOCALAPPDATA%` are not OpenCode global configuration roots.

Codex's current official documentation supports stdio MCP servers and global
configuration. OpenCode's current official documentation supports local MCP
commands and global rules. Claude Code supports user-scoped stdio MCP servers,
global `CLAUDE.md`, and auto-discovered skills. `kiokuko setup` uses the MCP and
instruction surfaces and installs the bundled `memory-reasoning`, `kiokuko-soul`, `kiokuko-simple-work`,
`kiokuko-single-purpose-functions`, `kiokuko-ui-design-soul`, `veteran-programmer-skill`,
and `natural-japanese-output` skills in the selected supported clients by
default. The skills are copied from a fixed package manifest and never downloaded
during setup. `--no-standard-skills`
skips placement without deleting an existing copy.

`veteran-programmer-skill` checks workflows across setup, delivery, persisted
state, and runtime handoffs. `natural-japanese-output` guides Japanese wording
while preserving technical identifiers and required output structure. Both are
routed by `kiokuko-soul` when applicable; neither introduces DSH-specific
execution or changes the MCP intake gate.

Hermes Agent v0.20.4 uses a profile-scoped native stdio MCP client. Kiokuko writes
only the effective profile's `config.yaml` entry:

```yaml
mcp_servers:
  # Managed by `kiokuko setup`.
  kiokuko:
    command: kiokuko
    args: [mcp]
    env:
      KIOKUKO_SKILL_DISCOVERY: official
```

It does not create a global instruction file, Hermes plugin, or Hermes hook.
Hermes's built-in memory and Kiokuko's bundled skills remain separate capabilities.
Use `kiokuko setup --clients hermes`, then restart Hermes Agent or start a new
session; `/reload-mcp` only reloads MCP registration. Smoke-test with
`hermes mcp test kiokuko`.

- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)
- [Codex skills](https://developers.openai.com/codex/skills)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
- [OpenCode rules](https://opencode.ai/docs/rules/)
- [OpenCode skills](https://opencode.ai/docs/skills)
- [Claude Code MCP servers](https://code.claude.com/docs/en/mcp)
- [Claude Code memory and CLAUDE.md](https://code.claude.com/docs/en/memory)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Hermes skills](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/work-with-skills.md)

## Guarantees and non-guarantees

Setup guarantees safe, repeatable configuration merging and makes the Kiokuko MCP
tools available in each configured client scope after that client reloads its
configuration and makes the bundled standard skills discoverable after a client
restart or new session. Global instructions request `task_prepare` before non-trivial work, grounded
`task_answer` calls when intake fields are missing, and checkpointing after
substantial verified work.

No supported client guarantees that a model will call an available tool for every
prompt. Therefore “automatic” means no per-repository install and no manual CLI
lifecycle after one-time setup; it does not mean Kiokuko intercepts every prompt
or response. For Hermes specifically, automatic/model use is best effort from
MCP tool descriptions.

The `kiokuko-soul` standard skill is the canonical first-read router. Managed
instruction surfaces require it before another bundled Kiokuko skill. Every
`task_prepare` call requires `soulRead: true` as an explicit claim that the
complete local Skill was read for that logical request, and the capability gate
requires an exact local `kiokuko-soul` descriptor for every task. Omission or
false attestation is invalid; missing or unknown capability availability returns
`required_capability_unavailable` even while intake needs an answer. A
namespaced, fetched, or reference-only skill does not satisfy the required
master SOUL. The boolean attestation is enforceable protocol evidence, not
remote proof that a model understood or followed the Skill.

The `memory-reasoning` standard skill is installed by default, but filesystem
placement is not proof that the current model loaded or followed it. For ready
build/debug tasks, clients advertise the exact local capability only when it is
actually available. If it is missing or availability is unknown, Kiokuko sets
`memoryPolicy.contextWithheld=true`, reports `memory_reasoning_missing` or
`memory_reasoning_unknown` in `memoryPolicy.withheldReason`, returns no actionable
ordinary memory, and leaves `nextAction=proceed`. An unmanaged same-name file
causes setup to fail closed; move or remove that file manually before rerunning
setup if Kiokuko should own the destination.

The UI standard skill is intended for explicit UI, UX, frontend, screen, SwiftUI,
accessibility, and equivalent Japanese-language tasks. `task_prepare` treats it
as a first-party recommendation only for such concrete terms; generic `design`,
backend-only work, and image-only generation do not trigger it.

The UI and function standard Skills use progressive disclosure. Their short
`SKILL.md` files are mandatory indexes, while versioned expert fragments are
selected for the concrete component, function, design decision, or WorkUnit.
Normal execution reads one to three fragments rather than every reference.

The single-purpose-functions standard skill applies to writing, modifying,
reviewing, debugging, and refactoring code across languages and repositories.
Its examples use typed TypeScript for concreteness, but the contracts explicitly
adapt to the target project's language, error model, persistence layer, and test
framework. `task_prepare` treats it as a first-party recommendation for concrete
coding terms in English or Japanese. Explicit no-code, documentation-only, and
image-only work do not trigger it. Kiokuko does not claim that availability alone
forces model use.
