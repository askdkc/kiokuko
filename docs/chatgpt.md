# ChatGPT connection notes

[Quick start in the README](../README.md#use-with-chatgpt-preview) | [日本語](chatgpt.ja.md)

## Install a supported version

If `kiokuko mcp --help` lists `--profile` and `--access`, use that installation.
To install from source, run the following in the Kiokuko repository root.

```bash
npm ci
npm run build
npm install --global .
kiokuko mcp --help
```

Run `kiokuko init` only if no database exists. ChatGPT does not require `kiokuko setup`.

## Troubleshooting

| Symptom | Action |
|---|---|
| Cannot create or select a Tunnel in ChatGPT | Check permissions and the target ChatGPT workspace association in the [official guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). |
| Cannot connect | Run doctor below. If `kiokuko` is not found, update the Tunnel launch command to the path returned by `command -v kiokuko`. |
| Missing or incompatible database | For a missing DB, run `kiokuko init`. For an incompatible DB, preserve it and use a compatible Kiokuko version. |
| Cannot save | Check for `--access read-write` and make sure `KIOKUKO_INTERACTION_MEMORY=off` is not set. |
| Configuration changes do not appear | Restart the Tunnel, Refresh the connection in ChatGPT Plugins, and start a new conversation. |

```bash
tunnel-client doctor --profile kiokuko-chatgpt --explain
```

## Scope and stopping

- Saves, recalls and corrects Global memory. Project memory is not exposed.
- Keep the connection private to the database owner. Recalled memory is sent to ChatGPT.
- Your computer and Tunnel must be running. Automatic save/recall on every turn is not guaranteed; this does not replace ChatGPT's built-in memory.
- To stop, press Ctrl+C in the Tunnel terminal. To disconnect permanently, remove the connection from ChatGPT Plugins. The database remains.

**Live ChatGPT connection and write approval remain unverified.** [Validation status](chatgpt-validation.md)
