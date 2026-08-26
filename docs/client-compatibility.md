# Client compatibility policy

Status: global MCP integration for Codex, OpenCode, Claude Code, and profile-scoped Hermes Agent. No client hook/plugin is installed.

| Client | Global MCP registration | Global instructions | Managed standard skills | Hooks/plugins |
|---|---|---|---|---|
| Codex | managed table in `~/.codex/config.toml` (or `$CODEX_HOME`) | managed block in global `AGENTS.md` | `~/.agents/skills/{kiokuko-ui-design-soul,kiokuko-single-purpose-functions}` | not installed |
| OpenCode | managed `mcp.kiokuko` property in global `opencode.json`/`opencode.jsonc` | managed block in global `AGENTS.md` | global config `skills/{kiokuko-ui-design-soul,kiokuko-single-purpose-functions}` | none |
| Claude Code | managed `mcpServers.kiokuko` property in `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) | managed block in global `CLAUDE.md` | Claude config `skills/{kiokuko-ui-design-soul,kiokuko-single-purpose-functions}` | none |
| Hermes Agent | managed `mcp_servers.kiokuko` in the effective profile `config.yaml` | none | effective profile `skills/{kiokuko-ui-design-soul,kiokuko-single-purpose-functions}` | none |
| Other MCP clients | manual `kiokuko mcp` stdio registration | client-specific | not installed | none |

OpenCode global configuration follows XDG paths on every platform:
`$XDG_CONFIG_HOME/opencode`, or `~/.config/opencode` when unset. On Windows,
`~` resolves from `%USERPROFILE%`, falling back to `%HOME%`; `%APPDATA%` and
`%LOCALAPPDATA%` are not OpenCode global configuration roots.

Codex's current official documentation supports stdio MCP servers and global
configuration. OpenCode's current official documentation supports local MCP
commands and global rules. Claude Code supports user-scoped stdio MCP servers,
global `CLAUDE.md`, and auto-discovered skills. `kiokuko setup` uses the MCP and
instruction surfaces and installs the bundled `kiokuko-ui-design-soul` and
`kiokuko-single-purpose-functions` skills in the selected supported clients by
default. The skills are copied from a fixed package manifest and never downloaded
during setup. `--no-standard-skills`
skips placement without deleting an existing copy.

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

The UI standard skill is intended for explicit UI, UX, frontend, screen, SwiftUI,
accessibility, and equivalent Japanese-language tasks. `task_prepare` treats it
as a first-party recommendation only for such concrete terms; generic `design`,
backend-only work, and image-only generation do not trigger it.

The single-purpose-functions standard skill applies to writing, modifying,
reviewing, debugging, and refactoring code across languages and repositories.
Its examples use typed TypeScript for concreteness, but the contracts explicitly
adapt to the target project's language, error model, persistence layer, and test
framework. `task_prepare` treats it as a first-party recommendation for concrete
coding terms in English or Japanese. Explicit no-code, documentation-only, and
image-only work do not trigger it. Kiokuko does not claim that availability alone
forces model use.

Kiokuko does not install hooks or plugins in any supported client. During an
upgrade, setup removes only the byte-exact retired OpenCode guard and the one
exact retired Claude prompt handler. A modified, duplicate, relocated, or
partial legacy identity is `CONFLICT` and requires manual review; unrelated
client settings are preserved.

`task_prepare` can accept an ephemeral catalog of skill and MCP-tool names from
the calling client. Kiokuko matches Akinator policy recommendations and task
terms against that catalog, but cannot enumerate another MCP server or a
client's private skill registry by itself. A result therefore distinguishes
`available`, `missing`, and `unknown`; it never treats a fetched `SKILL.md` as
installed or executable. External skill discovery is controlled independently
by `KIOKUKO_SKILL_DISCOVERY=off|official|community` and defaults to `official`.
When enabled, Kiokuko compares the project fingerprint with relevant client
skills rather than checking whether the catalog is globally empty. An omitted
catalog is treated as unknown availability; official reference-only discovery
may still proceed, but fetched skills are never treated as installed or
executable. Akinator discovery and `kiokuko skills find` share the same
provider-backed `findSkills` operation. There is no legacy fixed-source sync or
guessed-source fallback; bounded exact verification of a reviewed,
catalog-pinned source remains.

`task_prepare` also requires a bounded opaque `requestId`. Clients create a new
ID for every logical user request, including a later request with identical task
text, and reuse an ID only for an exact transport retry. Reusing an ID with
changed bound intake input is `CONFLICT`; `client.sessionId` is not a turn or
request identity. The raw request ID is not stored.
The normalized context budget is part of the bound request and every
`task_answer` must repeat it; a changed budget conflicts before intake mutation.

The legacy ungated `guide context` path was removed. Task-aware context must use
`task_prepare` / `task_answer` or the generic Agent bridge so the same
`memory-reasoning` hard gate applies. External Skill discovery belongs to
`task_prepare` or the explicit `skills find` / `skills import` commands.

Every `task_answer` request must include the exact `run.runId`, capability
catalog, and context budget supplied to `task_prepare`; clients must not fall
back to session-only run lookup or replace those bindings between answers. Inspect
`nextAction` after every `task_prepare` and `task_answer` response. For a ready
build/debug task with actionable recalled context, the local `memory-reasoning`
capability is a hard gate. If the catalog says `missing` or `unknown`, Kiokuko
returns `required_capability_unavailable`; the client must report the boundary
and stop instead of continuing through `catalog_similarity`, legacy
instructions, external Skill discovery, fetched skills, or any other fallback.
When it is available, the client must read the local `memory-reasoning` Skill
before modifying code and convert recalled claims that affect the task into
verified premises, falsifiable invariants, concrete counterexamples, and
regression tests. Catalog availability alone does not satisfy this execution
contract.
If the client cannot obtain the Kiokuko policy for a non-trivial build/debug
request, it must also stop and report that boundary. Repository-only
continuation for such a request is allowed only after the policy establishes
that no Kiokuko memory was delivered or used.

## Scope boundary

The stdio MCP server calls Kiokuko's memory services only through
`task_prepare`, `task_answer`, and lifecycle tools. It never exposes the SQLite
file or a direct recall tool. Human/operator CLI and Web inspection remains
management-only. Task context is limited to the resolved current repository
and/or the reserved global workspace; it never searches unrelated project
workspaces. Writes are candidate-only, untrusted, bounded, content-hash
idempotent, audited, and passed through secret detection.

The generic Agent Gateway remains available for explicit execution-ledger
workflows and applies the same task capability gate.
