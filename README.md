# Kiokuko (記憶庫)

Version 1.0 requires a new database and removes the previous orchestration. See [breaking changes and setup cleanup](docs/breaking-changes-1.0.md).

English | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

**Connect through MCP, recall useful context, and build reusable project memory.**

Kiokuko is local external memory for AI coding agents. It stores durable knowledge
in SQLite, retrieves relevant context for the next task, and records useful results
after work. You keep using your client normally; the client calls Kiokuko through MCP.

## The core idea

```text
request → MCP connection → retrieve relevant memory → do the work
                                             ↓
                                  save reusable knowledge
```

Memory is separated into Project, Ecosystem, and Global scopes. Current source,
configuration, and execution results take precedence over remembered context.

## Quick start

Node.js 24.16.0 or newer is required (Node.js 26.1.0 or newer is also supported).

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup` initializes the local database, detects supported clients, installs the
bundled standard Skills, configures their MCP connection, and enables local semantic
retrieval. The first run installs the embedding runtime and model. Restart a client that
was already running after setup. Exact configuration rules and recovery procedures
are in the [Getting started guide](docs/getting-started.md).

To configure clients without installing the embedding runtime or model:

```bash
kiokuko setup --no-embeddings
```

This skips embedding setup and preserves any existing embedding settings.

## Uninstall

Stop clients using Kiokuko and any `kiokuko serve` process first.

```bash
kiokuko uninstall --dry-run
kiokuko uninstall
# After selecting all agents and completing cleanup, run the printed command:
npm uninstall --global kiokuko
```

Use Up/Down to move, Space to toggle, Enter to submit, and Esc to cancel. All choices start unchecked.
Only selected agents' managed settings and Skills are removed. **Selecting all four also deletes shared memory, embedding models, and managed project bindings**, then prints the npm removal command. Partial selection retains shared data and the npm package. User content is preserved.
For scripts, use `kiokuko uninstall --clients opencode,claude` or `kiokuko uninstall --all` for complete cleanup.
Use the same environment overrides as setup for custom locations. See [cleanup scope and failures](docs/cli-contract.md#uninstall).

## Main features

- **RAG memory**: lexical retrieval plus local semantic retrieval configured by `setup`.
- **Akinator**: clarifies vague requests before work begins.
- **Local Web UI**: review and curate saved memories.
- **Reference-only Skills**: discovered external Skills are verified and never executed automatically.

`kiokuko embeddings setup` remains a compatibility entrypoint for `kiokuko setup`.

Managed MCP blocks are updated and registered-project instructions are refreshed.
An unmanaged identity is replaced only after interactive confirmation; non-interactive
and `--dry-run --json` invocations fail closed without changing it. See the
[semantic retrieval guide](docs/semantic-retrieval.md) for runtime, offline, and
fallback behavior.

## Supported clients

- Codex
- OpenCode
- Claude Code
- Hermes Agent

Client-specific setup, Web UI, and restart instructions are in
[Getting started](docs/getting-started.md). The [documentation index](docs/README.md)
links to conceptual and operational guides.

## Safety and limitations

Kiokuko does not store full conversations and rejects content that resembles secrets
such as passwords, API keys, tokens, or private keys. Saved memories are advisory;
verify them against the current repository and runtime.

MCP use is client- and model-mediated. There is **no guarantee that Kiokuko is called
on every turn**. If a client cannot initialize the required MCP connection, a client
may stop rather than silently continue without policy. Trust boundaries and public
error behavior are documented in [Security and trust](docs/security-and-trust.md).

## More detail

- [Documentation index](docs/README.md)
- [Getting started](docs/getting-started.md)
- [Concepts](docs/concepts.md)
- [Semantic retrieval](docs/semantic-retrieval.md)
- [Security and trust](docs/security-and-trust.md)
- [CLI contract](docs/cli-contract.md)

Implementation-focused references remain in [architecture](docs/architecture.md),
[database](docs/database.md), [execution ledger](docs/execution-ledger.md), and
[client compatibility](docs/client-compatibility.md).
