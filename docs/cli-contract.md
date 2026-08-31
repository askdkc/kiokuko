# Embedding CLI contract

The default global installation is intentionally lightweight:

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

This keeps lexical retrieval and the normal setup flow available without the
optional local semantic runtime. To opt into local semantic retrieval, run the
following command. It installs the pinned optional dependencies when needed,
then refreshes registered-project instructions. It does not rewrite global
client MCP configuration; use `kiokuko setup` for explicit client setup:

```bash
kiokuko embeddings setup
```

`boolean@3.2.0` is an upstream transitive dependency of the Transformers.js
runtime. It is not a Kiokuko dependency and is not present in the lightweight
install. On Linux, the first automatic dependency installation uses sudo
through npm. On macOS and other platforms it invokes npm directly, preserving
the package manager's configured ownership. Do not persist npm script
permissions or use `--dangerously-allow-all-scripts`.

`kiokuko embeddings setup` installs the pinned `local-small` preset without a
separate confirmation flag. Automation uses:

```bash
kiokuko embeddings setup --preset local-small --json
```

`--dry-run` performs no download, model load, database write, or filesystem
mutation. `--offline` uses only an existing verified installation. `--replace`
allows switching profiles. `status --json` reports bounded coverage and model
state; `repair` restores the same pinned artifact without destructive cleanup.
