# Kiokuko (記憶庫)

Version 1.0 requires a new database and removes the previous orchestration. See [breaking changes and setup cleanup](docs/breaking-changes-1.0.md).

English | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

**Connect through MCP, learn from interaction, and recall useful context.**

Kiokuko is local external memory for AI agents, for coding work and ordinary
conversation. Your client can save durable preferences, decisions, corrections,
and useful results as untrusted SQLite records, then recall relevant context for
the next interaction. You keep using your client normally through MCP.

## The core idea

```text
request → MCP connection → retrieve relevant memory → do the work
                                             ↓
                                  save reusable knowledge
```

Recall defaults to 16,000 Unicode body characters, with a separate bounded typed-relation envelope. Explicit budgets and item limits are preserved. See [context delivery](docs/context-delivery.md).

Memory is separated into Project, Ecosystem, and Global scopes. Current source,
configuration, and execution results take precedence over remembered context.

## Quick start

Node.js 24.16.0 or newer is required (Node.js 26.1.0 or newer is also supported).

```bash
npm install --global kiokuko
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

<a id="setup-messages"></a>

### npm notices and setup errors

`install scripts not yet covered by allowScripts` means npm has no recorded
approval for those dependency scripts. `esbuild` is a build tool; `fsevents`
supports macOS file watching. The notice alone does not mean setup failed.

Run this in the package directory that produced the notice:

```bash
npm install-scripts ls
```

If it lists `esbuild` and `fsevents`, and you have reviewed and want to allow their
scripts, record approval with:

```bash
npm install-scripts approve esbuild fsevents
```

Approval updates that directory's `package.json`. For a global macOS Kiokuko
install, use the installed Kiokuko directory shown in the error; running these
commands in another project reviews and changes that project's policy.
See [npm's script approval guide](https://docs.npmjs.com/cli/v11/commands/npm-install-scripts/).

If setup ends with `Local semantic retrieval dependencies remain unavailable`
and `Cannot find package ... @huggingface/hub/index.js`, the embedding runtime
could not load and semantic setup is incomplete. Script approval is not a
confirmed fix for this import error. Report the full error and the output of
`kiokuko --version`, `node --version`, and `npm --version` when requesting help.

### Saved runtime for Codex

To keep Codex MCP and lifecycle hooks on one version while npm replaces its installation, prepare a separate runtime in a private application-data directory. Finish current work and stop Codex before changing its configuration:

```bash
kiokuko runtime-prepare --runtime-root "$HOME/Library/Application Support/Kiokuko/runtimes" --json
kiokuko setup --clients codex --no-embeddings --no-standard-skills --runtime-manifest /absolute/path/to/runtime/manifest.json --client-stopped
kiokuko runtime-diagnose --manifest /absolute/path/to/runtime/manifest.json --json
```

On Linux, use `${XDG_DATA_HOME:-$HOME/.local/share}/kiokuko/runtimes` as the runtime root. Replace the manifest example with the `manifestPath` printed by the first command. If the current Node executable depends on libraries outside its own binary, preparation fails; supply a standalone Node binary with `--node /absolute/path/to/node`. Preparation never changes client settings. The setup command verifies the saved files, updates the managed MCP and all lifecycle hooks together, and restores previous configuration files if the update fails. Restart Codex only when the diagnostic reports `readyForRestart: true`. Existing custom MCP commands are preserved and require separate migration.

An npm update alone does not switch the saved version. To upgrade, stop Codex after current work, prepare the new version, run the setup command with its new manifest, then restart. Keep the old saved directory for recovery; old versions are not deleted automatically. If the new version migrated the memory database, check database compatibility before returning to an older version. Allow several hundred megabytes per saved version, depending on Node and installed optional dependencies; check the actual directory size before keeping multiple versions.

### Repository instruction files

`kiokuko use` keeps a short, stable pointer in the repository's `AGENTS.md`
(or the configured agent file). Kiokuko's generated instructions live in
`.kiokuko/AGENTS.md`, relative to the repository root. Template upgrades and
repository identity changes update that generated file without rewriting the
root pointer. Keep custom instructions outside Kiokuko's managed markers.
Existing versioned Kiokuko blocks migrate to the pointer on the next use/setup
refresh; user text and other products' sections remain unchanged. A missing
root instruction file is not recreated by routine setup; use `kiokuko doctor`
to review a repair. Missing generated instructions can be restored by use/setup
or an approved doctor repair. Uninstall removes only Kiokuko's managed regions
from both files, preserving surrounding content.

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

- **Interaction memory**: learns durable preferences, decisions, and corrections from ordinary conversation as untrusted candidates. [How it works](docs/interaction-memory.md).
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

Record sessions with [AgenticReplay](docs/agenticreplay.md) by wrapping the client
using Kiokuko. AgenticReplay is optional and installed separately.

## Use with ChatGPT (preview)

Connect a personal plugin in Developer mode to save and recall memory. No store-distributed plugin is available.

1. **Prepare Kiokuko.** Use a version whose `kiokuko mcp --help` lists `--profile` and `--access`; otherwise [install from source](docs/chatgpt.md). Run `kiokuko init` if you do not have a database.
2. **Install the Tunnel client.** On macOS, use the [official Homebrew instructions](https://github.com/openai/tunnel-client#install-with-homebrew):

   ```bash
   brew install openai/tools/tunnel-client
   tunnel-client --version
   ```

   For other operating systems, see the [official releases](https://github.com/openai/tunnel-client/releases/latest). In [Tunnel settings](https://platform.openai.com/settings/organization/tunnels), obtain a Tunnel ID associated with your ChatGPT workspace and a [runtime API key](https://platform.openai.com/settings/organization/api-keys) with Tunnels Read + Use permission.

3. **Start the connection on your computer.** Replace `<tunnel_id>` and `<runtime_api_key>` with your values.

   ```bash
   export CONTROL_PLANE_API_KEY="<runtime_api_key>"
   tunnel-client init \
     --sample sample_mcp_stdio_local \
     --profile kiokuko-chatgpt \
     --tunnel-id "<tunnel_id>" \
     --mcp-command "kiokuko mcp --profile chatgpt-memory --access read-write"
   tunnel-client doctor --profile kiokuko-chatgpt --explain
   kiokuko chatgpt run --profile kiokuko-chatgpt
   ```

   Keep it running while using the connection. In a new terminal, set the API key again and execute the final `run` command.

4. **Register in ChatGPT.** Enable **Settings → Security and login → Developer mode**. Under **Plugins → ＋**, name it `Kiokuko`, describe it as “Save and recall memory”, and choose **Connection → Tunnel** with the same ID. Select Kiokuko from the tools menu in a new conversation. [Official UI instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt)

Try: “Save this information in Kiokuko” or “Search Kiokuko for memories about [topic].” Review and approve write requests when prompted.

For search only, change `read-write` to `read` in the launch command. This does not change ChatGPT's built-in memory storage. **Live ChatGPT connection testing is pending.** [Troubleshooting](docs/chatgpt.md)

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
- [Akinator profile memory](docs/akinator-memory.md)
- [Security and trust](docs/security-and-trust.md)
- [CLI contract](docs/cli-contract.md)

Implementation-focused references remain in [architecture](docs/architecture.md),
[database](docs/database.md), [execution ledger](docs/execution-ledger.md), and
[client compatibility](docs/client-compatibility.md).
