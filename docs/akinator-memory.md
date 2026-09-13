# Akinator profile memory

Profile memory can suggest earlier task targets and success examples during MCP intake. In `resolve` mode it can fill a missing target only when the current request names a verified file or directory inside the same repository. It never fills a current success condition or permission from history.

The default is `off`. Ordinary scoped memory retrieval continues to work in every mode. State-only intake reads and indexed tag lookup are always enabled.

## Configure the MCP server

Set `KIOKUKO_AKINATOR_MEMORY_MODE` in the environment of the process that runs `kiokuko mcp`, then restart that MCP server. It accepts:

| Value | Behavior |
|---|---|
| `off` | Do not probe or display profile history. |
| `shadow` | Record the bounded search result for evaluation; do not change answers or display hints. |
| `suggest` | Add optional, untrusted `intake.memoryHints` to the current question. |
| `resolve` | Also fill a missing literal repository target when every adoption condition passes. |

For example, run an MCP server with suggestions enabled:

```sh
KIOKUKO_AKINATOR_MEMORY_MODE=suggest kiokuko mcp
```

Both exact local capabilities `kiokuko-soul` and `memory-reasoning` must be available to search, adopt, or display profile history. A missing capability disables this optional feature; the existing task and ordinary-memory gates still apply. Model request text cannot change the mode or repository binding.

A hint is an example from a previous run, not a current user answer. Clients must preserve the current question and its options, and ask the user or verify current repository evidence before answering. Existing clients may ignore the extra field. No new MCP tool is required.

## Index existing history

The schema migration creates empty, rebuildable search tables. Normal requests update their own projection, but do not scan old sessions. An incomplete index never permits automatic adoption.

Use the packaged maintenance command on an explicitly selected existing database:

```sh
kiokuko akinator-memory rebuild --database /absolute/path/to/kiokuko.sqlite3 --json
```

Re-running resumes a partial rebuild. To discard and recreate only the search projection, use:

```sh
kiokuko akinator-memory rebuild --database /absolute/path/to/kiokuko.sqlite3 --restart --json
```

`--workspace <name>` restricts maintenance to one registered project. Batches commit progress atomically; interruption leaves the last committed cursor available for the next run. The command never selects the normal database implicitly. Use the existing backup command when a backup is needed; copying only a live SQLite main file is not a consistent backup.

## Decisions, replay, and privacy

- Current profile values win. `constraints: null` alone does not trigger a search.
- Queries run in exact-signal, word-FTS, then trigram order. At most three search queries and 64 unique canonical profile expansions are allowed. At most three hints and 4,096 serialized hint characters are displayed for the current question.
- Automatic adoption requires a complete projection and search, a completed source run with ready intake, a current literal target that exists inside the repository, an original `client_supplied` or `user_answer` source, and no competing target in the candidates. A score is a ranking value, not a probability.
- A changed or missing source is withheld. A stale projection marks the probe incomplete; integrity and identity failures are not silently reported as “no memory”.
- The original request hash excludes enrichment and mode. Exact replay uses the initial saved decision, while current source eligibility is checked before showing a hint. Answers already given are never restored to the initial profile.
- Resolution records contain references and hashes, not copied historical candidate values. Purging a source run removes its projection and clears references in other resolutions. The current task profile and its existing audit events remain distinct from a hint cache.
- `memory` provenance never becomes independently grounded knowledge merely through repeated reuse. These copied fields are also excluded from hints, so a purged root cannot return through an enriched intermediate run. A server-adopted target does not create a fake answer.

The probe adds no LLM call, network request, embedding generation, or semantic search. SQLite executes synchronously. The 100 ms check between stages does not interrupt a running statement and is not a hard timeout. Broad queries or large common-word matches can exceed the candidate budget; the result remains incomplete and requires the normal question flow.

## Archive and rollback

Ledger archive v4 includes profile resolutions and the `memory` source value. The importer still accepts strict v3 archives, including their original source allowlist. Projection and FTS tables are not archived; rebuild after importing history. Imported references must pass current repository and canonical-source checks before use.

Migration `002_akinator_memory_probe.sql` leaves the published baseline unchanged. The new reader supports old source values. Setting the mode to `off` stops new adoption and hint display but does not undo the migration or make an old binary compatible with the new database. Restore a pre-upgrade backup to downgrade; do not rewrite `memory` to a different source value.

## Verify and measure

```sh
npm run typecheck
npm test
npm run test:evaluation:akinator
npm run test:benchmark:akinator
npm run test:benchmark:akinator -- --large
```

The evaluation uses synthetic, deterministic cases and prints JSON to stdout without creating report files. It measures fixture correctness and Recall@3; missing-profile-field counts are not measured human question counts. Real user correction rates and real-world error probabilities are not inferred from these cases.

The benchmark prints JSON to stdout and progress to stderr without creating report files. The default uses 1,000 entries / 100 profiles; `--large` uses 10,000 / 1,000 and 100,000 / 10,000. It reports SQL calls, canonical entry reads, elapsed time, transaction hold time, CPU, RSS, event-loop delay, each probe mode, and prepare with discovery disabled and no embedding runtime. The old tag scan and the new context retrieval have explicitly different measurement boundaries. Network/provider latency and concurrent load are not measured.

Source tests and package checks do not update an installed MCP server or its startup-loaded Skills.

Corpus construction alone reuses prepared SQL statements and yields between batches. Timed retrieval uses the normal adapter without that reuse. `sqlCalls` counts prepared statements, excluding transaction-control statements; `transactionMs` records time between successful BEGIN and COMMIT/ROLLBACK. The event-loop maximum covers corpus construction as well as measurements and must not be read as prepare latency.

### Local validation (2026-09-13)

The implementation passed all 1,666 repository tests, type checking, build, existing retrieval evaluation, the required SQLite-vec smoke test, sample-database validation, and package checks. The isolated global-install test also exercised the packaged rebuild command (required absolute database, restart, resume, JSON output) and all 22 bundled Skill files across four clients. No normal installation was updated.

The dedicated evaluation passed 12 synthetic cases without an incorrect adoption. This result describes those fixtures; it does not establish a real-world error or user-correction rate.

### Remaining acceptance limit

State-only intake performs zero entry-body reads and indexed tag retrieval avoids unrelated bodies. This does **not** make the full ready-state prepare path independent of corpus size: the existing `context/selection-state.ts` snapshot deliberately decodes every eligible entry and rejects a selection corpus above 10,000 entries. The 1,000-entry fixture measured 4,168 body expansions for a complete `resolve` prepare, including those existing snapshot checks. Off/shadow/suggest in that fixture remain at an unanswered intake and are not equivalent ready-state performance comparisons.

Consequently, the plan's full-prepare non-proportional-read / 100,000-entry acceptance condition remains unmet while preserving the existing snapshot contract. Addressing that condition requires a separate design for snapshot integrity and invalidation; this change does not remove its fail-closed bound or silently narrow the validated corpus. Benchmark reports retain prepare errors and exit nonzero when a prepare fails.

To reproduce the existing selection limit without first creating 10,000 profile histories, run `npm run test:benchmark:akinator -- --limit-check`. This uses 10,001 entries / one source profile, prints a JSON report, and is expected to exit nonzero at the existing ready-state selection bound.

| Fixture entries | Former tag-scan body reads | Indexed context body reads | State-only body reads |
|---:|---:|---:|---:|
| 1,000 | 1,000 | 12 | 0 |
| 10,001 | 10,001 | 12 | 0 |

The full 100,000-entry / 10,000-profile run also reached the same `INTEGRITY_ERROR: Context selection state exceeds the policy bound`. That run stopped before producing a complete timing report. The structured limit-check report reproduces the boundary without the long profile-history setup.
