# SQLite driver ADR

Status: accepted for the foundation slice
Date: 2026-08-20

## Decision

Kiokuko uses Node.js's built-in `node:sqlite` behind `src/db/adapter.ts`. The runtime driver is not exposed to repository or command code directly. Connections are opened by `src/db/connection.ts`, which applies the required connection pragmas on every file connection.

The package requires Node `>=24.0.0` and its development types track the Node 24 API. This support floor is a lifecycle policy: Node 22 reaches end-of-life on 2027-04-30, while Node 24 is supported through 2028-04-30. The selected backup API (`backup(sourceDb, path)`) is available below this floor, so API availability no longer determines the minimum supported runtime. See the [official Node.js release schedule](https://github.com/nodejs/Release#release-schedule).

The original foundation slice was verified on Node v22.23.1. The Node 24 support-floor update was verified on 2026-08-21 using Node v26.5.0, which is inside the supported `>=24.0.0` range; an exact Node 24 runtime was not available on that host.

## Evidence captured

Environment observed on 2026-08-20:

- OS/kernel: Linux 6.17.0-1019-oracle
- architecture: aarch64
- Node: v22.23.1
- `node:sqlite` exports: `DatabaseSync`, `StatementSync`, `backup`, `constants`, and a default export
- SQLite runtime: 3.51.3
- `npm view kiokuko name version dist-tags --json`: HTTP 404 / package not found; no publish was attempted
- Official pages used for client discovery returned HTTP 200 (recorded separately in `docs/client-compatibility.md`)

The capability fixture and tests exercised:

- file-backed database creation
- foreign keys, WAL, `synchronous=NORMAL`, and `busy_timeout=5000`
- transactional SQL and rollback
- FTS5 virtual table creation
- integrity check
- `node:sqlite` backup to a separate file and reopening the backup
- concurrent migration initialization from four processes

The focused capability test passed with FTS5, WAL, integrity check, and backup available. The connection and migration tests also verify that the configured pragmas are applied through the adapter path.

## Alternatives

| Candidate | Decision | Evidence/limitation |
|---|---|---|
| `node:sqlite` | Selected | Built into the verified Node runtime; no native npm addon or runtime dependency; the required foundation contract passed. |
| `better-sqlite3` | Not selected | A clean install and the complete cross-platform contract were not rerun in this worktree; adding it would introduce native ABI/prebuild risk without a demonstrated need. |
| Pure JS/WASM SQLite | Not selected | Durable WAL/locking and the complete multi-process contract were not established here; it would also add a larger runtime path than the built-in driver. |

This is a runtime decision, not a claim that every OS/client combination has been verified. Linux aarch64 is the only host measured in this slice. Windows, macOS, Linux x64, and Linux arm64 installation behavior remain follow-up verification work.

## Adapter rules

- Values go through prepared statements; migration metadata inserts are parameterized.
- Each file connection applies `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=NORMAL`, and `busy_timeout=5000`.
- Migrations are ordered, SHA-256 checked, forward-only, and applied one transaction at a time with `BEGIN IMMEDIATE`.
- Only bounded retries for SQLite lock/busy errors are allowed. SQL, validation, and checksum errors are not retried.
- `node:sqlite` is a release-candidate API in current Node 24 documentation, so this ADR must be revisited when its stability level or behavior changes.
