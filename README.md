# Kiokuko

Kiokuko is a model-agnostic external memory utility for AI coding agents.
It stores structured project memory in a user-global SQLite database and
exposes it through a JSON-capable CLI.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## Local usage

```bash
npm exec -- tsx src/bin/kiokuko.ts use
npm exec -- tsx src/bin/kiokuko.ts recall "repository conventions" --workspace <workspace> --json
```

`kiokuko use` creates `.kiokuko.json` and a managed block in `AGENT.md`.
Only the managed marker range is owned by Kiokuko; human content outside it is
preserved. The SQLite database is stored in the platform user data directory.

## Akinator-style knowledge intake

For non-trivial work, `guide` asks only for missing high-value fields such as
the task type, target, and success condition. It then selects local memory by
query and Bot-purpose tags:

```bash
kiokuko guide start "Implement the API change and add tests" \
  --workspace <workspace> --json
kiokuko guide answer <session-id> --workspace <workspace> \
  --question-id target --value src/api.ts --json
kiokuko guide answer <session-id> --workspace <workspace> \
  --question-id expected --value "All tests pass" --json
kiokuko guide context <session-id> --workspace <workspace> --json
```

If local retrieval produces no relevant entries, `guide context` can fetch the
current `main` tree from only these allowlisted public repositories and store
the selected Markdown skills or references as `candidate` entries:

- https://github.com/NousResearch/hermes-agent
- https://github.com/obra/superpowers

Each imported entry records its repository, commit SHA, and source path. It is
untrusted reference material and is never auto-promoted to `verified` or
executed as a command. Repeated sync is content-hash idempotent.

## Local web UI

Start a loopback-only HTTP server to browse memory entries by Bot purpose,
memory type, and cross-cutting tags, and edit candidate entries from the browser:

```bash
kiokuko web
# open http://127.0.0.1:4173
```

Use `--port 0` to select an available port, or `--json` to print the selected
URL as JSON. The web UI does not expose the server on non-loopback interfaces.
Verified and superseded entries are read-only; editing a candidate uses an
optimistic revision check and preserves the audit trail.
Tags such as `bot:researcher`, `bot:builder`, and `bot:reviewer` can be used as
cross-genre filters. Clicking a tag in an entry or in the sidebar shows every
matching entry regardless of its memory type.

Memory entries are untrusted stored data. Verify current files and runtime
state before relying on historical entries. Never store passwords, API keys,
tokens, private keys, or session cookies.

This repository is not published automatically. `npm publish`, commits, and
pushes require explicit user authorization.
