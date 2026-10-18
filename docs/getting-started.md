# Getting started

## Install and configure

Node.js 24.16.0 or newer is required. Install and configure in two commands:

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup` configures clients and local semantic retrieval by default. To skip the
embedding runtime, model download, and embedding generation:

```bash
kiokuko setup --no-embeddings
```

Existing embedding settings and models are preserved. This flag does not disable
a previously configured semantic profile. Other setup flags include
`--no-standard-skills`, `--skill-discovery off|official|community`, and `--dry-run --json`.

In a terminal, use Up/Down to move, Space to toggle a client, and Enter to confirm.
Number keys 1–4 also toggle clients. Detected clients start checked; multiple clients can be selected.
Press Esc or Ctrl+C to cancel selection. For automation, specify clients with `--clients codex,opencode`.

For Codex, setup owns one exact managed block:

```toml
[mcp_servers.kiokuko]
command = "kiokuko"
args = ["mcp"]
enabled = true
required = true
```

The discovery environment line is managed with that block. Missing `required`, changed values,
ordering, duplicate keys, extra fields, or an explicit `required = false` are
user-managed conflicts and are never silently overwritten. Interactive setup asks
whether to replace a conflicting identity; JSON, non-interactive, and dry-run calls
return `CONFLICT` without mutation. The same rule applies to other supported clients.

Restart a running client after setup. Use `kiokuko doctor --json` to inspect runtime,
database, and Codex MCP health without changing files. Ordinary `kiokuko doctor`
automatically creates missing registered root and generated instruction files in
TTY and noninteractive use, without waiting for input. Recreation restores only
Kiokuko instructions, not deleted custom content. It verifies the current registered
identity, workspace, binding, and file identities, preserves existing files, and
reports recovery failures while continuing other registered targets.
Interactive repair of existing Kiokuko sections still asks for confirmation.
Repair preserves user text and other products' sections. Kiokuko instructions are
plugin-only HTML comments; normal setup updates migrate older sections to this format.
JSON checks report the affected path and reason under
`data.checks.agentFiles.findings` without prompting or changing files.
Missing `.kiokuko.json` files are reported as `missing_binding_file` with the
binding path, registered repository ID, and restoration guidance. Invalid bindings
include the validation error; doctor does not recreate either kind automatically.
Failed active-task inspections appear under `data.checks.memoryAssurance.findings`
with the task ID, repository root, exception code and bounded message, and recovery
guidance. Human output shows the same findings. A snapshot byte-budget error means
the inspected Git-tracked, unignored and configuration files exceed 64 MiB; review
large artifacts without deleting task records or memory. Pending reviews and
missing verification counts alone do not make the assurance health check fail.

## Embeddings setup

`kiokuko setup` installs the declared peer-compatible local semantic runtime and runs client
configuration, including conflict confirmation, managed MCP replacement, and
registered-project instruction refresh. `kiokuko embeddings setup` is a compatibility
entrypoint for the same implementation and also accepts `--no-embeddings`.

```bash
kiokuko setup --clients codex
kiokuko setup --preset local-small --offline
kiokuko embeddings status --json
```

`--replace` switches from another active embedding profile. `--dry-run` performs no
download or mutation; `--json` is suitable for automation and fails closed on an
unmanaged MCP identity.

## Web UI and clients


Answer-only requests use the evidence already in the conversation without creating a task run or recalling memory. A decision-relevant missing fact can use bounded `task_inspect`; `operation: "diff"` accepts `scope: "auto" | "staged" | "working-tree"`. Auto prefers the index when staged changes exist and returns the selected scope. External diff, textconv and worktree filters are disabled. Code changes, operations, formal reviews and implementation plans retain intake and verification. Additional checks must change a decision or establish completion; there is no minimum thinking duration.

Normal setup updates preserve custom instruction text and refresh existing managed blocks and Skills. If a previously configured client's global instruction file or a registered project's instruction file is absent, setup reports it as skipped instead of recreating it. Run ordinary `kiokuko doctor` to restore a registered project's missing Kiokuko instructions without waiting for confirmation.
