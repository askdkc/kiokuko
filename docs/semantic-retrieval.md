# Semantic retrieval

`kiokuko setup` configures lexical retrieval and the local `local-small` semantic
profile. Use `kiokuko setup --no-embeddings` to skip embedding setup while preserving
any existing embedding settings. `kiokuko embeddings setup` remains a compatibility entrypoint.

```bash
kiokuko setup
kiokuko embeddings status --json
kiokuko setup --offline
```

Setup installs only the pinned runtime and verifies every artifact before loading
it. `--offline` requires an already verified local installation; `--dry-run` does
not download, write, or change the active profile; `--replace` switches from a
different active profile. Model weights are not included in the npm package.

The command also runs the normal client setup flow: managed MCP blocks and project
instructions are refreshed. Exact old managed blocks are upgraded automatically.
An unmanaged or tampered identity requires interactive confirmation; JSON,
non-interactive, and dry-run automation fails closed with no configuration change.

If the local runtime, model, or vectors are unavailable, lexical retrieval and old
vectors remain usable. `status` and `doctor --json` expose coverage and health.
Embedding configuration is stored in SQLite, not environment variables. Platform-
specific runtime installation details and allowlists are kept in the implementation
references and release checks.
