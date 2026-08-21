# Security

Kiokuko v1 is a same-user, loopback-only service. Remote bind, TLS termination, provider credential proxying, and multi-user authorization are non-goals.

## Runtime boundary

- Only `127.0.0.1`, `::1`, or `localhost` may be bound.
- A random 256-bit capability token is stored only in a runtime descriptor with mode `0600`.
- `/api/v1/*` and readiness require a constant-time bearer check.
- The token never appears in stdout/JSON, argv, `AGENTS.md`, events, logs, or error details.
- A per-database lock prevents two server instances; stale descriptors/locks are replaced only after owner/PID checks.
- Permissive CORS is disabled. Browser mutations require authenticated, CSRF-safe requests and explicit confirmation where destructive.
- The bounded write queue returns `429` rather than consuming unbounded memory. Shutdown drains accepted work before owner-checked descriptor/lock cleanup.

The stdio MCP path is local to the spawning AI client and does not open a
network listener. It exposes no raw SQL or arbitrary-workspace parameter.
`task_prepare`, `task_answer`, and `memory_recall` resolve only the
supplied/current working directory plus the reserved global workspace.
Client-supplied capability catalogs are bounded, used only for the current
response, and never persisted. `memory_checkpoint` accepts bounded typed
entries, runs secret detection, and always writes `candidate` + `untrusted`
memory.

OpenCode setup writes a dependency-free local loop-guard plugin. It receives
the tool hook data already exposed by OpenCode, computes SHA-256 fingerprints
for repetition detection, and retains only those fingerprints and bounded
counters in process memory. It does not log, persist, or transmit tool
arguments/results. A new user message or terminal session event clears the
state.

## Pre-persistence sanitization

Every captured task, profile hint, intake answer, event, evidence summary, feedback comment, and proposal follows this order:

```text
strict validation
→ owned JSON snapshot
→ recursive key/value sanitization
→ URL/path/environment normalization
→ byte-size check
→ canonical JSON/hash
→ transaction
```

Sensitive keys such as authorization, cookie, password, secret, token, and API key are replaced. Known token/private-key/credential patterns are detected using the existing memory secret scanner. URLs lose userinfo, query, and fragment; workspace paths become relative; external home prefixes are redacted; environment values are omitted except explicit harmless allowlists. Provider-private hidden reasoning, binary content, whole repository files, and unbounded stdout/stderr are never accepted.

A matched value is not repeated in exceptions, hashes, logs, response details, or temporary tables. Oversized events are rejected rather than silently truncated. Only explicitly defined preview fields may be truncated, with metadata recording that fact.

## Storage and delivery

Workspace is mandatory and immutable after run-open. Queries are parameterized. Execution records do not become curated memory automatically. Promotion is explicit and candidate-only. Feedback is a weak ranking signal and cannot mutate trust/status or an existing intake profile/policy.

Stored content is returned with an `untrusted` marker and rendered as text nodes in the UI. The gateway never obeys instructions inside memory/events. Clients must verify current repository/runtime evidence independently.

## Existing source fallback

The Akinator guide may fetch only `https://github.com/mattpocock/skills`, outside server write transactions, and only after an explicit zero-skill assertion. An omitted capability catalog does not opt in. Documents marked `disable-model-invocation: true` are excluded. Imported documents are sanitized, bounded, commit-pinned, `candidate`, and `untrusted`; incomplete source trees are rejected. Imported `SKILL.md` content is reference data, not an installed capability, and is never automatically executed. Named client support is not inferred from documentation reachability.

## Privacy operations

Existing memory purge requires explicit confirmation. Ledger purge likewise keeps only a content-free tombstone. `doctor` scans integrity, migration checksums, FTS, ledger sequence/hash/orphans, permissions, runtime descriptor/lock state, and secret-pattern counts without displaying values. Backups may retain earlier content and must be managed separately.
