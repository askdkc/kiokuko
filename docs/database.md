# Database baseline

Kiokuko 1.0 initializes a new database from `migrations/001_baseline.sql`.
The baseline includes memory revisions, task intake and ledger, scoped context,
external Skill discovery, CJK word/trigram search, and semantic search tables.
SQL performs no network access, model loading, or vector generation.

`schema_migrations` binds the baseline filename and SHA-256 checksum. Reopening
an initialized database does not reapply SQL. Unsupported histories, missing
history on a nonempty database, and altered checksums fail before writes.
Orphan WAL/SHM files and rollback journals also cause refusal; initialization
never moves sidecars or invokes recovery for them. The preflight inspects a
temporary DB/WAL copy so SQLite cannot alter the original SHM read marks.

Only current data formats are read. Schema initialization never converts old
memory, restores obsolete settings, or deletes unreadable rows. Optional
Embedding providers used by current runtime and evaluation remain supported;
new installations start with semantic search disabled until explicit setup.

See [the 1.0 breaking changes](breaking-changes-1.0.md) for existing installations.
