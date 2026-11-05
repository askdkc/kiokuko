# Kiokuko (記憶庫)

English | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

Local memory for AI agents. Save preferences, decisions, and corrections in
SQLite, then recall relevant context through MCP.

Works with **Codex, OpenCode, Claude Code, and Hermes Agent**.
[ChatGPT support is in preview](docs/setup-notes.md#chatgpt).

## Install

Requires Node.js **24.16.0 or newer**.

```bash
npm i -g kiokuko
kiokuko setup
```

Restart your client. Add `--no-embeddings` only to skip embedding setup.

Upgrading from before 1.0 requires a new database.
[Migration and cleanup](docs/breaking-changes-1.0.md).

### Codex desktop recording (macOS)

Add your projects in Codex, then run from any directory:

```bash
kiokuko setup --clients codex --codex-dock-record
```

Quit Codex completely and reopen it from the Dock. Newly added projects register
when first used. Memories are saved only after approval.

## Docs

<a id="setup-messages"></a>

- [Getting started](docs/getting-started.md)
- [Setup, troubleshooting, and uninstall](docs/setup-notes.md)
- [Memory and search](docs/concepts.md)
- [History and code evidence](docs/history-evidence.md)
- [All documentation](docs/README.md)

Saved memories can be wrong. Kiokuko rejects secret-like content and does not
store full conversations. MCP calls depend on your client and model.
[Security and trust](docs/security-and-trust.md).
