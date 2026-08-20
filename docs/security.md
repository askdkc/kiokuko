# Security

Kiokuko v1 is a same-user, loopback-only service. Remote bind, TLS termination, provider credential proxying, and multi-user authorization are non-goals.

## Runtime boundary

- Only `127.0.0.1`, `::1`, or `localhost` may be bound.
- A random 256-bit capability token is stored only in a runtime descriptor with mode `0600`.
- `/api/v1/*` and readiness require a constant-time bearer check.
- The token never appears in stdout/JSON, argv, `AGENT.md`, events, logs, or error details.
- A per-database lock prevents two server instances; stale descriptors/locks are replaced only after owner/PID checks.
- Permissive CORS is disabled. Browser mutations require authenticated, CSRF-safe requests and explicit confirmation where destructive.
- The bounded write queue returns `429` rather than consuming unbounded memory. Shutdown drains accepted work before owner-checked descriptor/lock cleanup.

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

The Akinator guide may fetch only code-allowlisted public official sources, outside server write transactions. Imported documents are sanitized, bounded, commit-pinned, `candidate`, and `untrusted`; incomplete source trees are rejected. Named client support is not inferred from documentation reachability.

## Privacy operations

Existing memory purge requires explicit confirmation. Ledger purge likewise keeps only a content-free tombstone. `doctor` scans integrity, migration checksums, FTS, ledger sequence/hash/orphans, permissions, runtime descriptor/lock state, and secret-pattern counts without displaying values. Backups may retain earlier content and must be managed separately.
