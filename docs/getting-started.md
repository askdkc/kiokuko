# Getting started

## Install and configure

Node.js 24.16.0 or newer is required. Install and configure in two commands:

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

Optional setup flags: `--no-standard-skills`, `--skill-discovery off|official|community`, and `--dry-run --json`.

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
database, and Codex MCP health; doctor is read-only.

## Embeddings setup

`kiokuko embeddings setup` installs the pinned local semantic runtime and runs the
same client configuration flow as `kiokuko setup`, including conflict confirmation,
managed MCP replacement, and registered-project instruction refresh.

```bash
kiokuko embeddings setup --clients codex
kiokuko embeddings setup --preset local-small --offline
kiokuko embeddings status --json
```

`--replace` switches from another active embedding profile. `--dry-run` performs no
download or mutation; `--json` is suitable for automation and fails closed on an
unmanaged MCP identity.

## Web UI and clients