# Embedding CLI contract

`kiokuko embeddings setup` installs the pinned `local-small` preset after
explicit confirmation. Automation uses:

```bash
kiokuko embeddings setup --preset local-small --yes --json
```

`--dry-run` performs no download, model load, database write, or filesystem
mutation. `--offline` uses only an existing verified installation. `--replace`
allows switching profiles. `status --json` reports bounded coverage and model
state; `repair` restores the same pinned artifact without destructive cleanup.
