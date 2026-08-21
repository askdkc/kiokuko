# Database

Kiokuko uses a user-global SQLite database:

- Linux: `$XDG_DATA_HOME/kiokuko/kiokuko.sqlite3`, fallback `~/.local/share/kiokuko/kiokuko.sqlite3`;
- macOS: `~/Library/Application Support/kiokuko/kiokuko.sqlite3`;
- Windows: `%LOCALAPPDATA%\\kiokuko\\kiokuko.sqlite3`.

The selected adapter is built-in `node:sqlite`. Writable connections enable foreign keys, WAL, `synchronous=NORMAL`, and a 5000 ms busy timeout. Read-only upgrade inspection does not change journal or synchronization mode. Writes use `BEGIN IMMEDIATE` and retry only lock/busy errors with a bounded policy.

## Migrations

Migrations are forward-only and each applied file records its SHA-256 checksum. Applied migrations 001–004 are immutable. Hybrid retrieval is additive in migrations 005 and 006; it retains the word FTS index, adds trigram and structured-signal projections, and versions cross-scope delivery metadata without rewriting v1 rows. Migration 007 adds qualified Akinator reasoning paths for Curator without backfilling or treating retrieval history as evidence:

1. repositories, bindings, curated memory, tags/links, memory audit;
2. FTS5 and synchronization triggers;
3. Akinator sessions/answers and allowlisted knowledge source snapshots.

Migration 004 adds the Agent Gateway execution ledger described in `execution-ledger.md`: runs, one-to-one intake links, intake feedback, append-only events/evidence, context deliveries/entries/feedback, run feedback, memory provenance links, and purge tombstones. It is additive and preserves existing memory/Akinator rows on upgrade.

`akinator_reasoning_paths` links one proposed entry revision to one run and its intake session. The unique `(run_id, entry_id, entry_revision)` key blocks same-run duplication. `qualified` is set only by the checkpoint service for completed actionable paths with fresh verification or a passing test. Concept aggregation uses a server-derived normalized hash; no user-supplied concept key or retrieval counter can increase it.

Before any command applies pending migrations to an existing supported database,
Kiokuko opens it read-only, validates that its migration history is a contiguous
checksum-matching prefix, and creates a verified SQLite backup in the adjacent
`backups/` directory. The backup filename records the source and target schema
versions. Migration does not start if backup creation or `integrity_check` fails.
Each migration remains individually transactional, and a failed migration leaves
the verified pre-upgrade backup in place.

A database containing a migration version newer than the running Kiokuko binary
is rejected before it is opened for writes. The user must upgrade Kiokuko; an
older binary never attempts a downgrade or silently ignores unknown schema.

`run_intakes` enforces one run ↔ one Akinator session and matching workspaces. Intake feedback enforces exactly one question/profile target and actor/idempotency uniqueness. Event IDs are globally unique; source IDs and local sequences are unique within a run. Foreign keys prevent orphaned evidence/delivery/feedback/link records.

## Server ownership

The foreground HTTP server keeps one primary connection for its lifetime and serializes ledger writes through a bounded FIFO. Generic execution-ledger clients never open SQLite. The stdio MCP process opens a short-lived connection per high-level memory tool call, as do existing direct memory CLI operations; WAL and the busy timeout support concurrent same-user processes.

The `repositories` table includes a reserved `kiokuko_global`/`global` row.
Project locations remain separate. Default scoped recall queries only the current
project workspace and the reserved global workspace.

All write requests carry an idempotency key. An acknowledged canonical request can be replayed; a different body under the same scope/key conflicts. Event batches are atomic and local sequence allocation occurs inside the transaction.

## Backup, export, and integrity

A full SQLite backup uses SQLite's supported backup API and includes curated memory, memory audit, execution ledger, deliveries, and feedback. Automatic pre-migration backups use the same API, are stored under the current user's data directory with restrictive POSIX modes, and are created only when an existing database has pending migrations. Existing workspace memory export does not silently include ledger data. Ledger archive has its own deterministic manifest/checksum.

`doctor` checks database integrity, migration checksums, FTS synchronization, dangling references, ledger contiguous sequence/hash/cursor invariants, secret residue counts, and server descriptor/lock consistency. Purge uses services rather than manual SQL and preserves content-free ledger tombstones.
