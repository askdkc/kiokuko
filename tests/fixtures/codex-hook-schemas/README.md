# Codex hook output schema snapshots

Generated JSON schemas from OpenAI's Apache-2.0 licensed `openai/codex`
repository, read on 2026-10-12 from `codex-rs/hooks/schema/generated`.
Upstream Git blob identities:

- `pre-tool-use.command.output.schema.json`: `6730b27fd4fc80f8075d64346a554a1cfc94470a`
- `post-tool-use.command.output.schema.json`: `011f887265f21b549d029e96932b75b23dde8107`

Source: https://github.com/openai/codex/tree/main/codex-rs/hooks/schema/generated
Release behavior: https://learn.chatgpt.com/docs/hooks

The schemas reject unknown fields. Some parsed fields are not implemented in a
release; the consumer fixture also restricts responses to the supported shapes
Kiokuko emits. These snapshots validate the wire contract, not active desktop
enforcement or the version of a running client.
