# Diagnostic retention

Retention is disabled by default. An operator can preview a 30-day policy without writing configuration or data:

```sh
kiokuko diagnostics-retention --days 30 --dry-run --json
```

Enable it and compact eligible detail with:

```sh
kiokuko diagnostics-retention --days 30 --json
```

Only completed, failed, cancelled or interrupted runs whose **end time** is strictly older than the cutoff are eligible. Active and intake runs are never age-deleted. Runtime startup and Codex prompt submission perform bounded transactional maintenance at most once per day; read-only ChatGPT recall does no maintenance. Each pass handles at most 50 runs, deferring runs with more than 5,000 detail rows. The report lists deferred work. Reference scanning is bounded to 50,000 records, 32 MiB of JSON, and 200,000 distinct string references; exceeding a limit defers compaction safely. Each pass removes at most 1,000 expired hook observation rows. Disable automatic retention with `--disable`.

Compaction retains run summaries, memory bodies and immutable revisions, feedback and its workspace/delivered-revision links, provenance links, preparation/retry receipts and terminal hook call identities. Evidence referenced by review, verification or retry records remains available. Complete event chains used by memory provenance or ledger evidence are retained. Readers explicitly report when unreferenced detailed events have expired; they cannot certify an expired event chain.

String command output cannot prove an exit code. Unknown completions use deduplicated call state and per-run counters, rather than one unknown evidence row per command. Running processes remain pending; trusted structured completion can later produce one evidence record for the original command. Assurance reports separate hook observations, availability of exit metadata, model-reported results and client-observed results. A historical observed hook does not establish that the current client supplies exit metadata.

`reusablePages` and `reusableBytes` describe SQLite pages available for reuse inside the database. `diskBytesReclaimed` remains zero: this operation does not perform full vacuuming or promise to shrink the database file. WAL files may change size independently. Useful history and active work are deliberately protected even when that limits savings.
