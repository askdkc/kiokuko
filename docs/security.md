# Security

Kiokuko v1 is a same-user, loopback-only service. Remote bind, TLS termination, provider credential proxying, and multi-user authorization are non-goals.

The same OS user is also the local filesystem trust boundary. Cooperative
Kiokuko/SQLite processes are supported, and observable database/backup path,
inode, permission, size, or digest changes fail closed. Pure Node exposes SQLite
and managed-file cleanup through pathnames, however, and does not provide a
portable compare-inode-and-unlink operation. Opening, committing, or removing a
pathname therefore cannot be made atomic with an external identity/hash check
against a malicious same-user peer that interposes between individual filesystem
instructions. Kiokuko binds and revalidates observable identities, quarantines
owned cleanup artifacts, and reports ambiguous or incomplete cleanup instead of
claiming success. Run untrusted local processes under a different OS account;
Kiokuko does not claim to sandbox them.

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
`task_prepare` and `task_answer` resolve only the
supplied/current working directory plus the reserved global workspace.
`task_prepare` requires a bounded opaque client-generated request ID. Kiokuko
stores only its idempotency hash; a reused ID with changed bound intake input
conflicts before a second run can be created. A client session ID is not used as
a request identity. The normalized context budget is bound into the run and a
changed budget is rejected before intake mutation or context delivery.
Client-supplied capability catalogs are bounded, used only for the current
response, and never persisted. `memory_checkpoint` accepts bounded typed
entries, runs secret detection, and always writes `candidate` + `untrusted`
memory. Global candidates, including preferences, require caller-supplied
structured applicability or an explicit portable reason. Curator suggestions
are deterministic heuristics over project candidates plus qualified Akinator
paths, not trusted model decisions.
Retrieval frequency is never accepted as qualification. The path store requires
a linked intake/run, one path per entry revision per run, a completed actionable
silo, grounded target/success sources, and fresh verification or a passing test.
These are bounded client evidence claims, not cryptographic proof; the resulting
candidate remains untrusted and requires human review. CLI and Web UI global
promotion require explicit user action. MCP `curator_globalize` additionally requires the caller
to assert `confirmed=true` after showing the skill name and three-line overview;
this is a protocol guard, not proof of consent, so installed client instructions
also prohibit inferred permission. All flows use optimistic revision checks,
strip project path signals from the new global scope, and keep the result
`candidate` + `untrusted`.

Setup installs no client hook or plugin. Model-facing task memory is returned
only by `task_prepare` / `task_answer`; explicit CLI and Web memory inspection
is a human/operator management surface, not an ungated model fallback.

MoA advisors are not subprocesses launched by Kiokuko. A parent host is
responsible for proving read-only isolation before it reports a slot; hosts
that cannot do so must report `unavailable`. Advisor payloads contain no Enno
identity or provider/model identity. The parent aggregator is the only caller
of `enno_advice_submit`. Contributions are strict, slot-complete, canonical
JSON with 16 KiB per-slot and 48 KiB per-round UTF-8 limits. Secret-shaped
completed output is converted to the fixed `unsafe_output` failure without
persisting or forwarding the raw value; failed/timeout/unavailable slots carry
only fixed reason codes.

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

Revision content has one canonical hash format. The schema upgrade rewrites
only the exact released preimage recoverable from persisted rows and fails the
transaction on ambiguity or mismatch. No read, write, doctor, archive, or
replay path attempts a legacy hash after migration.

## Storage and delivery

Workspace is mandatory and immutable after run-open. Queries are parameterized. Execution records do not become curated memory automatically. Promotion is explicit and candidate-only. Feedback is a weak ranking signal and cannot mutate trust/status or an existing intake profile/policy.

Stored content is returned with an `untrusted` marker and rendered as text nodes in the UI. The gateway never obeys instructions inside memory/events. Clients must verify current repository/runtime evidence independently.

## External skill discovery

External skill discovery uses `official` mode by default during Akinator task
preparation. `KIOKUKO_SKILL_DISCOVERY=off` disables it, while `community`
remains explicit opt-in. Interactive `kiokuko setup` asks before writing
`community` into the selected clients' MCP environment; its default answer is
no, and non-interactive setup requires an explicit `--skill-discovery community`
flag or `KIOKUKO_SKILL_DISCOVERY=community` environment setting. It derives
bounded queries from the project fingerprint and never sends the user's request,
source code, file paths, repository name, or secrets to the registry. Discovery
calls a provider directly; it never starts `npx`, a shell, or an arbitrary child
process.
Context-delivery replay is limited to the same effective discovery mode and the
same bounded normalized capability catalog. Only their canonical hash contributes
to run identity; the capability catalog itself is not persisted. Changing either
value while reusing a logical request ID is a conflict. The caller must create a
new logical request and request ID to open a run under the changed inputs.

When authenticated v1 search returns the documented 401 authentication failure, Kiokuko records a token-free
typed failure in the v1 provider's negative cache and tries the Compatibility
Provider once with the same bounded query. Compatibility results use their own
provider cache key, bound to the normalized non-secret provider origin, so
changing `KIOKUKO_SKILLS_API_URL` cannot reuse results or failures from the old
origin. Credentials and URL query data are never included in errors, cache
bodies, provenance, provider identity, or audit records.

Search candidates are revalidated against a current commit-pinned GitHub tree.
Only bounded `SKILL.md`, `references/**/*.md|txt`, and `docs/**/*.md` files
are accepted. Invalid frontmatter, disabled model invocation, secret-like
content, truncated trees, redirects outside the allowlist, and oversized
snapshots are rejected. Imported documents are stored in a dedicated external
workspace as `reference` + `candidate` + `untrusted`; they are never installed,
executed, registered as MCP tools, marked `verified`, or written to Global.
Only an active imported mapping with matching source commit and explicit
applicability can bypass the normal portability filter for Ecosystem recall.
Community candidates also pass a local GitHub/source/path/duplicate safety gate.
Every identity outside Kiokuko's exact locally reviewed source/slug/path catalog
requires a fresh explicit provider audit result with `passed` status. Missing
or failed audit results reject the import. A provider-supplied `curated`,
`catalog-verified`, or `owner-verified` label does not authorize storage. These
candidates are not treated as trusted or installed capabilities.
Automatic task preparation materializes at most one Skill by default. An
explicit internal caller may request two; every other limit is rejected before
provider, source, or database work begins.
An existing import suppresses a new search only when it has explicit reusable
applicability and still satisfies the current mode: official mode requires the
exact locally reviewed catalog identity, while community mode may also reuse an
audited import. Refreshing a noncatalog identity requires a new passed audit;
the previously stored audit label is not reused as authority.
An aged import is refreshed automatically only when the provider returns its
exact identity in the current run. Empty provider results never trigger a
direct GitHub/source fallback. Provider search and audit transport failures
latch the remaining provider stages for that run; audit rate limits and
availability failures use provider-and-skill-bound persistent backoff, including
bounded `Retry-After` handling.

There is no legacy fixed-source sync or guessed-repository fallback. Bounded
exact verification of a reviewed, catalog-pinned source remains part of the
source validation path.
The ungated `guide context` / `guide_context` compatibility path was removed.
Task-aware memory is returned only through capability-gated task preparation or
the generic Agent bridge. External Skill lookup uses the provider-backed
`findSkills` path through `task_prepare` or explicit `skills` commands.

## Privacy operations

Existing memory purge requires explicit confirmation. Ledger purge likewise keeps only a content-free tombstone. `doctor` scans integrity, migration checksums, FTS, ledger sequence/hash/orphans, permissions, runtime descriptor/lock state, and secret-pattern counts without displaying values. Backups may retain earlier content and must be managed separately.
