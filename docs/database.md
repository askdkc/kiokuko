# Database

Kiokuko uses a user-global SQLite database:

- Linux: `$XDG_DATA_HOME/kiokuko/kiokuko.sqlite3`, fallback `~/.local/share/kiokuko/kiokuko.sqlite3`;
- macOS: `~/Library/Application Support/kiokuko/kiokuko.sqlite3`;
- Windows: `%LOCALAPPDATA%\\kiokuko\\kiokuko.sqlite3`.

The selected adapter is built-in `node:sqlite`. Writable connections enable foreign keys, WAL, `synchronous=NORMAL`, and a 5000 ms busy timeout. Read-only upgrade inspection does not change journal or synchronization mode. Writes use `BEGIN IMMEDIATE` and retry only lock/busy errors with a bounded policy.

## Migrations

Migrations are forward-only and each applied file records its SHA-256 checksum. The current fresh schema stores identity/lifecycle state in `entries`, immutable content in `entry_revisions`, and historical tags in `entry_revision_tags`. Hybrid retrieval is additive in migrations 005 and 006; it retains the word FTS index, adds trigram and structured-signal projections, and versions cross-scope delivery metadata. Migration 007 adds qualified Akinator reasoning paths for Curator without backfilling or treating retrieval history as evidence:

1. repositories, bindings, current memory identities, immutable revisions, revision tags/links, and memory audit;
2. FTS5 current-revision projections;
3. Akinator sessions/answers and allowlisted knowledge source snapshots.

Migration 004 adds the Agent Gateway execution ledger described in `execution-ledger.md`: runs, one-to-one intake links, intake feedback, append-only events/evidence, context deliveries/entries/feedback, run feedback, memory provenance links, and purge tombstones. Context delivery entries use a composite foreign key to the exact `(entry_id, entry_revision)` row; replay never follows the current revision pointer.

Migration 010 adds `nudge_deliveries`, the content-free presentation history for deterministic checkpoint nudges. Migration 011 adds database guards for the supported nudge policy, code/priority pairs, and bounded JSON snapshots. Migration 012 validates the persisted structural identity of released `context-ranking-v2` and `context-ranking-v3` scoped deliveries during setup. It preserves their original delivery IDs, policy versions, character metadata, delivery items, and all historical references. Legacy preview text was not persisted and is not reconstructed during upgrade. Legacy deliveries remain available for audit and feedback references, but are never replayed as current `context-ranking-v4` context; invalid persisted legacy structure aborts the migration transaction. New scoped deliveries continue to use `context-ranking-v4`.

Migration 018 removes the migration-013 trigger that made a completed Enno
client binding immutable. The columns remain unchanged, but now store mutable
routing metadata so the adapter can atomically move one unambiguous active run
between local project clients. Run, workspace, orchestration, revision,
idempotency, and terminal-state constraints are unchanged.

Migration 019 adds Enno execution-integrity state. It adds `route_epoch`,
hashed short-lived resume tokens, WorkUnit execution leases, owner nonces and
lease expiry to operation receipts, and recoverable verifier-run ownership.
Final verifier rows gain verifier-specification and pre/post repository-state
digests plus a repository-change flag. Existing receipts and verifier history
are preserved; legacy evidence remains readable for audit but is deliberately
unbound and cannot satisfy a new Final Review. Expired `started` ownership is
changed to `abandoned` transactionally before a new owner claims the operation.

Migration 021 adds the rebuildable semantic projection without changing
canonical memory: immutable `embedding_profiles`, singleton
`embedding_runtime`, current/stale `entry_embeddings`, durable leased
`embedding_jobs`, and bounded `query_embeddings`. Entry revision transactions
only enqueue or reset jobs. Provider calls and vector generation are never run
inside a migration or entry transaction. Current retrieval joins vectors back
to the active profile, current revision, and canonical content hash; stale rows
remain reusable by document hash but are ineligible for search. Purging an entry
removes its vectors and jobs through foreign-key cascades. Workspace JSONL
export excludes this derived projection; a full SQLite backup includes it.

`akinator_reasoning_paths` links one proposed entry revision to one run and its intake session. The unique `(run_id, entry_id, entry_revision)` key blocks same-run duplication. `qualified` is set only by the checkpoint service for completed actionable paths with fresh verification or a passing test. Concept aggregation uses a server-derived normalized hash; no user-supplied concept key or retrieval counter can increase it.

Migration 009 adds the external-Skill tables and completes the revision-hash
clean break in the same upgrade transaction. It accepts only a canonical hash
or the one exact released preimage recoverable from that revision's persisted
tag order and structured scope, rewrites accepted rows to canonical scope and
locale-independent UTF-16 tag order, and then records the hash-format
singleton. A forged preimage or canonical identity collision aborts the entire
migration. Runtime reads, writes, replay detection, doctor, export, and import
use only the canonical hash; there is no post-migration legacy fallback.

For databases that use the supported migration history, before any command applies pending migrations to an existing database,
Kiokuko opens it read-only, validates that its migration history is a contiguous
checksum-matching prefix, and creates a verified SQLite backup in the adjacent
`backups/` directory. The backup filename records the source and target schema
versions. The exact already-open read-only connection is serialized in memory,
validated with `integrity_check` and `foreign_key_check`, and handed to a
directory-identity-bound worker that uses a create-only filename. The returned
directory identity, file identity, size, mode, and SHA-256 digest are rebound and
held through migration. Migration does not start if any check fails.
Each migration remains individually transactional, and a failed migration leaves
the verified pre-upgrade backup in place.

Supported concurrency means cooperative Kiokuko/SQLite processes using SQLite's
locking protocol. A malicious process running as the same OS user is outside the
filesystem trust boundary: Node's pathname-only SQLite constructor cannot make
opening a database inode atomic with a later pathname check, and SQLite commit
cannot be made atomic with an external file hash check. Kiokuko fails closed on
every path, inode, mode, size, or hash mismatch it can observe, but it does not
claim protection from a peer that can rename or rewrite this user's files between
individual instructions. Isolate untrusted peers under a different OS account.

A database containing a migration version newer than the running Kiokuko binary
is rejected before it is opened for writes. The user must upgrade Kiokuko; an
older binary never attempts a downgrade or silently ignores unknown schema.

`run_intakes` enforces one run ↔ one Akinator session and matching workspaces. Intake feedback enforces exactly one question/profile target and actor/idempotency uniqueness. Event IDs are globally unique; source IDs and local sequences are unique within a run. Foreign keys prevent orphaned evidence/delivery/feedback/link records.

## Server ownership

The foreground HTTP server keeps one primary connection for its lifetime and serializes ledger writes through a bounded FIFO. Generic execution-ledger clients never open SQLite. The stdio MCP process owns one database, embedding runtime, worker, and bounded write queue for the transport lifetime; transport close stops the worker before closing the queue and database. Human/operator memory-management CLI operations use short-lived connections; WAL and the busy timeout support concurrent same-user processes.

The `repositories` table includes a reserved `kiokuko_global`/`global` row.
Project locations remain separate. Default scoped recall queries only the current
project workspace and the reserved global workspace.

External Skill discovery stores provider search outcomes in
`skill_discovery_cache` and typed GitHub/source transport failures in
`skill_source_failure_cache`. Typed provider-audit rate limits and availability
failures use the separate `skill_audit_failure_cache`, keyed by provider,
normalized repository identity, and case-sensitive Skill slug. Expiry
timestamps are strict; cache pruning validates all three tables and commits
their deletions atomically.
`external_skills.generation` is allocated from a durable AUTOINCREMENT
high-water mark and participates in refresh and list-snapshot compare-and-swap
checks. Only tokens referenced by live Skill rows are retained, so repeated
updates do not create an unbounded tombstone table; the singleton clock and
SQLite sequence must agree before reads or writes proceed.

All write requests carry an idempotency key. `gateway_idempotency` stores the atomic mutation acknowledgement, not the later capability-gated context enrichment. An acknowledged canonical request can be replayed without repeating its mutation; a different body under the same scope/key conflicts. Post-commit capability gating and retrieval are re-evaluated against current retrievable revisions and feedback, so the full HTTP response may change across an exact replay while the stored acknowledgement remains unchanged. Event batches are atomic and local sequence allocation occurs inside the transaction.

## Backup, export, and integrity

 A full SQLite backup serializes the exact already-open read-only connection, validates the standalone image in memory, and installs it through the same create-only, directory-identity-bound writer used for automatic backups. It includes curated memory, all immutable revisions, memory audit, execution ledger, deliveries, nudge deliveries, and feedback. The backup command never initializes or migrates its source; a missing source is `NOT_FOUND`, and an existing output is `CONFLICT` and remains byte-for-byte unchanged. Its final output component must be portable and cannot use an alternate-stream colon, a trailing dot/space, or a Windows device name. Automatic pre-migration backups use the serialized exact inspection connection, are stored under the current user's data directory, use restrictive `0700`/`0600` modes on POSIX, and are created only when an existing database has pending migrations. Windows uses create-only and inode/file-identity checks without pretending its mode bits provide POSIX ACL semantics. Workspace archive v2 exports current semantic state only, does not include ledger data or revision history, and accepts only workspaces whose current entries are all at revision 1. Export and import fail explicitly for a higher current revision; use a full SQLite backup when history exists. Import idempotency requires the same entry IDs and exact record metadata; matching content under a different ID is a conflict and is never remapped. Both directions enforce the same 64 MiB total, 10,000-line, and 512 KiB-per-line limits and reject secret-like persisted text. Database-backed dry runs execute the same complete collision preflight without writing. Export reads one SQLite snapshot, commits it before filesystem work, and installs output atomically as a create-only file; an existing target is a conflict and is never overwritten. Ledger archive has its own deterministic manifest/checksum and preserves exact context and nudge delivery history.

`doctor` checks database integrity, migration checksums, FTS synchronization, dangling references, ledger contiguous sequence/hash/cursor invariants, legacy delivery structure, secret residue counts, and server descriptor/lock consistency. If migration 012 cannot be applied because legacy delivery structure is invalid, doctor performs a bounded read-only inspection and reports all findings without modifying the database. Purge uses services rather than manual SQL and preserves content-free ledger tombstones.

`setup` creates the pre-upgrade backup before applying pending migrations. If the upgrade finds an unreadable saved-memory entry, setup preserves the original entry in that backup, excludes only the unreadable entry from the active database, and completes the migration. The success output reports how many entries were recovered this way.

To restore a full SQLite backup, keep the current database and any `-wal`, `-shm`, or `-journal` sidecar files as rollback copies, then copy the backup to the original database pathname; do not use workspace `import` for a full SQLite backup. A standalone backup has no matching sidecars, so old sidecars must not remain beside it:

```sh
DB="$HOME/Library/Application Support/kiokuko/kiokuko.sqlite3"
BACKUP="<new-backup.sqlite3>"
for SUFFIX in "" -wal -shm -journal; do
  [ -e "$DB$SUFFIX" ] && mv "$DB$SUFFIX" "$DB$SUFFIX.before-restore-<timestamp>"
done
cp "$BACKUP" "$DB"
kiokuko setup
```

On Linux, use `${XDG_DATA_HOME:-$HOME/.local/share}/kiokuko/kiokuko.sqlite3` for `DB`. On Windows, use `%LOCALAPPDATA%\kiokuko\kiokuko.sqlite3`. Choose an unused timestamp, keep the `.before-restore-*` file until the restored memory is verified, and move it back if the restore must be rolled back. If a pre-migration backup was created automatically, it is under the database directory's `backups/` directory.
