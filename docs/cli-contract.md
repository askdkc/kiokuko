# Embedding CLI contract

The default global installation is intentionally lightweight:

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

This keeps lexical retrieval and the normal setup flow available without the
optional local semantic runtime. To opt into local semantic retrieval, make a
one-time reinstall that explicitly allows only the required install scripts,
then run setup:

```bash
npm install --global @askdkc/kiokuko @huggingface/hub@2.16.1 @huggingface/transformers@4.2.0 sqlite-vec@0.1.9 --allow-scripts=onnxruntime-node,sharp,protobufjs
kiokuko embeddings setup
```

`boolean@3.2.0` is an upstream transitive dependency of the Transformers.js
runtime. It is not a Kiokuko dependency and is not present in the lightweight
install. Do not persist `allow-scripts` in user/global npm configuration or
use `--dangerously-allow-all-scripts`.

`kiokuko embeddings setup` installs the pinned `local-small` preset after
explicit confirmation. Automation uses:

```bash
kiokuko embeddings setup --preset local-small --yes --json
```

`--dry-run` performs no download, model load, database write, or filesystem
mutation. `--offline` uses only an existing verified installation. `--replace`
allows switching profiles. `status --json` reports bounded coverage and model
state; `repair` restores the same pinned artifact without destructive cleanup.
