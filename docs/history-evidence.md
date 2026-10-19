# Scoped history and code evidence

History is advisory evidence, never executable instructions, approval, or a claim
that a rejected implementation is accepted. This feature does not change the
native human review required to save reusable memories. Model extraction, quoted
“user approved” text, reported outcomes, and a successful evidence write cannot
approve a proposal or authorize code execution.

## Active facts and ancestry

Normal recall excludes superseded entries. The existing `superseded_by` chain and
immutable `entry_revisions` preserve their content. With related search active,
a query matching an older fact can resolve to its exact current successor. Only
that current entry enters active recall. Same-target supersession retries are
idempotent; different targets, stale revisions, cycles, missing entries and
explicit cross-identity/branch replacements are refused atomically. Existing
interaction corrections keep successor insertion and predecessor supersession
inside one transaction.

```bash
kiokuko recall "project decisions" --cwd /absolute/path/to/project --scope project --history --max-output-chars 14000 --json
```

`--history` is project-only and implies compact JSON output. It requires the exact
registered project and cwd; it does not fall back to similarly named repositories,
files, or branches. Existing recall without these new options keeps its previous
shape and body-budget behavior. `--related-mode active` also enables current
successor matching; ordinary off/observe modes do not expand successors.

`historyDelivery` separates `ancestors` and `codeVersions` from active `items`.
Ancestors retain their entry ID, workspace, immutable revision, successor ID and
superseded status. Legacy or unqualified applicability is `unknown`, never an
invented approval or compatibility result. Completeness means only that the
bounded, eligible stored history for the provided items was delivered from the
read snapshot; it says nothing about unrecorded attempts or model effectiveness.

## Retaining code attempts

```bash
kiokuko code-version record --cwd /absolute/path/to/project --input-json /absolute/path/to/evidence.json --json
kiokuko code-version show attempt-2 --cwd /absolute/path/to/project --max-output-chars 14000 --json
```

The JSON input contains an existing `runId`, a unique `versionId`, a repository-
relative `path`, `outcome`, `reason`, and a single-file unified `diff` whose full
headers match that path. `entryId` links it to a memory; use that link for history
recall. Unattached raw evidence remains available through the owned `code-version show` point lookup; its response contains no active facts. Optional `parentVersionId` preserves version ancestry. For example:

```json
{"runId":"existing-run-id","versionId":"attempt-2","entryId":"existing-entry-id","path":"src/worker.ts","outcome":"failed","reason":"The focused test failed.","diff":"--- a/src/worker.ts\n+++ b/src/worker.ts\n@@ -1 +1 @@\n-return 0;\n+return 1;\n","requiredEnvironment":{"node":">=24.16.0"}}
```

These example IDs must be replaced with real identities; the command does not
create an approved memory or a task run. Code evidence reuses `ledger_evidence`
for the diff locator, SHA-256 digest and size. Migration 014 adds only the immutable
raw-code content and scope binding in `code_version_evidence`. Existing entry and
revision storage is retained. The diff is at most 64 KiB of UTF-8; diagnostics and
all removed/context/added lines pass the existing secret detector before storage.
Secret-shaped content is rejected in full, not silently redacted or truncated.
The saved digest identifies the exact stored diff. Input files are at most 256 KiB.

The native host captures local owner identity, registered repository/workspace,
actual Git branch and observed environment. Unknown branch/identity refuses a new
record; there is no default-branch fallback. Parent versions must share owner,
repository, workspace, branch, entry and full path. Reusing a version ID with a
changed request conflicts; an identical retry returns the prior receipt without
changing its originally observed environment. Evidence and raw content commit or
roll back together. Explicit ledger/memory purge can remove associated evidence;
SQLite backups retain this table. Existing ledger/workspace JSON archive formats
are not extended to export raw code versions in this change.

`reportedOutcome` is a claim about the attempt, not verification or approval.
Operator input may report accepted/rejected/failed/unknown, but the model-facing
capture tool accepts only failed/rejected/unknown. Every returned version has
`approval: "not_granted"`, `untrusted: true`, `instructions: false`, and
`executionPermission: false`. Accepted code evidence still grants no authority.

## Applicability

Structured scope supports exact `ownerIds`, `repositoryIds`, `workspaces`, and
`branches` constraints. They are checked before ranking and again during history
and related expansion. They do not introduce a multi-user authentication service;
local owner identity follows the native OS process and existing database access.
Other owners' code content, version IDs, counts and expected conditions are not
returned. Source/target repository names are never used as identity substitutes.

Observed environment values are descriptive. They alone do not establish
compatibility or make a different Node patch version incompatible. Optional
`requiredEnvironment` is enforced: `node` uses a valid semver range; other keys
match explicitly observed values exactly. Known mismatches omit the version as
`environment_incompatible`; an unobserved required value omits it as
`environment_unknown`. No declared requirements means applicability remains
`unknown`, even when the scoped raw evidence is provided. The same explicit
`environment` constraints are available in structured memory applicability.

## Bounds and omissions

The body still has its existing 16,000-code-point default and separate relation
budget. History mode adds a **hard final output budget**, default 32,000 Unicode
code points; `--max-output-chars` accepts 1–1000000. It counts the complete compact
CLI envelope, metadata, omission markers and newline. The MCP history tool also
counts the final JSON-RPC result, including text and structured representations.
This is independent of the body budget and is not a token count.

Whole versions/ancestors are omitted before active items; diffs are never partially
returned with a full-content digest. If necessary, whole active items are removed
and typed relations are restricted to the final item set. `outputDelivery` reports
the budget and `complete` or `omitted_budget`; `historyDelivery` reports `complete`,
`partial`, or `not_evaluated` with structured reasons. A budget too small for even
the explicit envelope/status returns `output_budget_too_small`, never an oversized
success. Error responses are a defined failure outcome, not evidence delivery.

Successor/ancestry depth and delivered ancestors are bounded at 64. Reverse
ancestry performs at most 256 candidate reads. Code history returns at most 32
versions, using indexed per-entry seeks for at most 33 metadata candidates each
and loading full diffs only for selected IDs. Parent validation has a 64-depth and
128-read bound. Input sets are bounded and deduplicated. An index-backed `LIMIT`
is used rather than sorting an unbounded diff history before a global limit.

`node_cap`, `depth_cap`, `missing_history`, `scope_unknown`, `output_budget` and
environment reasons do not mean exhaustive empty recall. `disposition` distinguishes
an actual omitted record (`omitted`) from work not evaluated (`not_evaluated`).
Selection is deterministic by stored time and version ID within a snapshot. No
pagination or claim of exhaustive history is exposed by this feature.

## MCP consumers

`task_history_recall` is read-only, bound to an active run, completed intake, cwd,
and its current delivery. Capability-withheld memory remains withheld. Only the
current delivery's eligible project items may seed history; use the existing
same-run `task_memory_refresh` for a new subject or changed memory. Historical
material does not become an untracked active-memory delivery or a review decision.

`task_code_version` stores operational failed/rejected/unknown raw evidence in
that native scope. It never calls memory approval or promotion. The ChatGPT/global
profile is unchanged and does not gain access to these local project tools.

Tests establish storage, scope, omission and caller behavior with synthetic data;
they do not establish better model performance or a general optimal context size.
