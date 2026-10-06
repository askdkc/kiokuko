# Client compatibility policy

Status: global MCP integration for Codex, OpenCode, Claude Code, and profile-scoped Hermes Agent.

| Client | Global MCP registration | Global instructions | Managed standard skills | Hooks/plugins |
|---|---|---|---|---|
| Codex | managed table in `~/.codex/config.toml` (or `$CODEX_HOME`) | managed block in global `AGENTS.md` | seven bundled skills below `~/.agents/skills/` | managed memory assurance hooks |
| OpenCode | managed `mcp.kiokuko` property in global `opencode.json`/`opencode.jsonc` | managed block in global `AGENTS.md` | seven bundled skills below global config `skills/` | none |
| Claude Code | managed `mcpServers.kiokuko` property in `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`) | managed block in global `CLAUDE.md` | seven bundled skills below Claude config `skills/` | none |
| Hermes Agent | managed `mcp_servers.kiokuko` in the effective profile `config.yaml` | none | seven bundled skills below effective profile `skills/` | none |
| Other MCP clients | manual `kiokuko mcp` stdio registration | client-specific | not installed | none |

ChatGPT has a separate conversation memory preview:
`kiokuko mcp --profile chatgpt-memory --access read`. It exposes only
`memory_policy` and Global `memory_recall`, with an exact bundled-policy
version/digest attestation instead of local Skill declarations. It is not a
`setup` target. [Tunnel setup](chatgpt.md) and [live validation status](chatgpt-validation.md)
are separate from local MCP test results. `--access read-write` adds Global capture and correction. Plugin distribution and
HTTP hosting are not included in this phase. The local capability gates below still
apply to the default MCP server.

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
`natural-japanese-output`, `one-shot-software-completion`, and
`coding-ideal-routine-skill` skills in the selected supported clients by
default. The skills are copied from a fixed package manifest and never downloaded
during setup. Codex uses host-specific names (`kiokuko-codex-soul`,
`kiokuko-codex-memory-reasoning`, and the other manifest-listed Codex names),
preserving legacy shared paths used by DSH. Deployment metadata records ownership,
host, contract version and hash; user-edited or foreign files are not overwritten.
`--no-standard-skills`
skips placement without deleting an existing copy.

`veteran-programmer-skill` checks workflows across setup, delivery, persisted
state, and runtime handoffs. `natural-japanese-output` guides Japanese wording
while preserving technical identifiers and required output structure. Both are
routed by `kiokuko-soul` when applicable; neither introduces DSH-specific
execution or changes the MCP intake gate.

`coding-ideal-routine-skill` is routed for coding requests after intake. It
connects investigation, meaningful failing tests, implementation, ordinary-use
acceptance checks, and evidence-based reporting. Explanation-only requests need
no implementation or Red/Green tests. Codex receives the manifest-listed name
`kiokuko-codex-coding-ideal-routine-skill`; other hosts keep the canonical name.

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

Default Codex assurance hooks pin the setup process's Node executable and the
package's compiled CLI with absolute paths. This avoids both `kiokuko` lookup
and `/usr/bin/env node` lookup in a GUI client's restricted PATH. An explicit
custom `--command` remains a caller-owned executable or wrapper. Rerun setup
after relocating Node or the package. Updating a package that active hooks use
can temporarily remove its files: switch to a separately installed, validated
runtime before replacing that installation, or update while the client is stopped.

`codex-hook --database <path> --diagnose-call <16-hex-id>` reads only the retained
protocol metadata for that exact diagnostic ID. It reads no command bodies or
conversation text and changes no task state. `completion_without_admission`
means completion lacks a recorded start; `completion_input_mismatch` means the
input differs from the admitted call. Both reject passing evidence. An already
executed tool must not be automatically rerun to repair a missing observation.

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
`reason=required_capability_unavailable` with `runCreated=false` before creating a run, retrieving memory or discovering skills. Invalid catalog items instead return `reason=invalid_capability_catalog` and bounded item indices and issue codes. A
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

## Interaction memory

All four setup targets receive the same capture/recall instructions and bundled
Skills. `memory_capture` stores untrusted candidates without ending a task;
`memory_recall` serves global conversation without a project. Project preparation
and capability withholding retain their existing gates. Reload the client after
setup so new tools and instructions are visible. Configuration coverage is not
proof of model behavior; see [per-client validation](interaction-memory-validation.md).

## Short-term handoff

All four MCP clients expose `handoff_save`, `handoff_load`, and `handoff_discard`.
The model saves a bounded state after meaningful changes and loads it by the exact
returned ID when a model/thinking change or work resumption is known. The default
`KIOKUKO_HANDOFF=auto` enables saves; `off` disables new saves and updates but
allows loading and discarding existing records until their 24-hour expiry.
Run-linked saves require the capability catalog bound at `task_prepare`.
Handoff state is untrusted and is not searchable long-term memory. The MCP server
does not observe model settings, compact native history, or guarantee a tool call
on every turn. A client reload is needed for newly installed tool descriptions
and Skill instructions; configuration alone does not prove live behavior.

### Correcting capability preparation

A refused `task_prepare` with `runCreated=false` has not bound the logical request.
Correct the complete `{kind, name, description?}` catalog and resend with the same
`requestId`. After a successful preparation, input remains immutable.
`task_memory_refresh` requires retrieval signals and cannot repair capabilities.

For a legacy capability-blocked run, use `task_prepare_recover` with its original
`requestId`, `runId`, current assurance revision, a stable `operationId`,
`soulRead: true`, `previousCapabilities`, and the corrected `capabilities`.
Omit `previousCapabilities` only when the original prepare omitted the catalog.
The server checks the saved digest and original prepare receipt. Runs without
these verifiable bindings, terminal runs, executed/captured/checkpointed runs,
and runs with in-flight discovery cannot be automatically recovered.

Recovery atomically closes the predecessor as failed and records exactly one
successor. The new intake session retains answers, their provenance and the
question budget. Retrieval budgets, time filters and related mode are retained;
capability and discovery bindings are rebuilt. Old deliveries and reviews stay
on the predecessor; the successor retrieves and reviews its own context.
Repeat the exact recovery input after a transport or retrieval failure: it
reuses that successor. Changed input, another operation ID or a terminal
successor is a conflict. Neither catalogs nor operation IDs are stored verbatim.

HTTP uses the same recovery service at
`POST /api/v1/agent/runs/:runId/prepare-recovery`. Put `operationId` in the
`Idempotency-Key` header, omit `runId` and `operationId` from the body, and retain
the original logical `requestId` in the body. Codex hooks verify the persisted
predecessor/successor receipt before rebinding; ordinary tools still require
completed intake and current memory reviews.

The new API requires the updated package and MCP process. Updating repository
source does not change an already running server or its client's tool catalog.
