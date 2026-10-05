# Correction and provenance validation

This work fixes checkpoint Git provenance and removes host ancestry assumptions
from repository-root unit tests. It also adds a reproducible, real-process
correction harness. Model-selected capture, persistence, retrieval and answer
quality are separate observations.

## Findings from the plan audit

- `fatal: Needed a single revision` also occurs when a referenced object is
  missing. A malformed HEAD can produce the same diagnostic as a non-repository.
- `git show-ref --verify --quiet` returns status 1 for an absent branch **and for
  empty or malformed loose refs**. Status 1 alone is not proof of an unborn HEAD.
- The resolver now checks Git directory discovery, symbolic branch identity,
  ref validity and Git's resolved loose-ref path. Bare repositories and linked
  worktrees are covered. Unknown failures remain `SERVICE_UNAVAILABLE`.
- The five-second budget is shared by Git subprocesses, which use `SIGKILL` on
  timeout and a 64 KiB output bound. Synchronous filesystem calls cannot promise
  a hard wall-clock deadline; the budget is checked around the observations.
- An unborn HEAD means that its valid symbolic target is currently absent. It
  does not prove the repository has never had commits: deleting a branch can
  produce the same state.
- The original external 17-assertion harness was unavailable. The table below
  maps the stated contracts to checked-in tests; it does not reconstruct or
  claim to rerun those unidentified assertions.
- A supersession chain retains foreign-key references. The synthetic purge
  regression removes A, then B, then C before testing replay. It does not relax
  deletion constraints or modify the schema.
- Capture-off disables automatic interaction capture, not explicit checkpoints.
  Its live scenario therefore corrects the explanation without explicitly asking
  for a save; otherwise a legitimate explicit-save path would invalidate the test.

Live baseline failures also exposed model-facing documentation gaps. A recall
request used a 16,000-character budget although recall permits 100–12,000, and
a Japanese query missed a preference stored with the English subject
`Japanese grammar`. In the same synthetic DB, `日本語文法` returned no entries
while `日本語文法 Japanese grammar` returned the expected entry. Literal subject
isolation is intentional and remains enforced. Field descriptions now state the
numeric budget and suggest a bounded, concise bilingual query reformulation.
They also distinguish an unrecorded correction from an unsuccessful lookup of
a memory the user says is already stored: the latter requires clarification
instead of adding a competing entry. These are guidance changes, not a claim
that the model will always comply; the revised live cohort measures compliance.

## Deterministic coverage

| Contract | Checked-in verifier |
|---|---|
| Known non-repository diagnostics, malformed refs/HEAD, missing objects, bounded probes, strict SHA | `tests/unit/scoped-memory-git-provenance.test.ts` |
| Checkpoint failure leaves entries, ledger and run unchanged | `tests/integration/scoped-memory.test.ts` |
| Root precedence and hermetic no-root decisions | `tests/unit/repository-identity.test.ts` |
| Real no-root, parent marker, Git and binding in Linux container | `tests/ci/repository-root-smoke.mjs` |
| Fresh stdio process A→B→C, stale revision, old-result exclusion, exact replay, disabled capture, purge replay | `tests/integration/interaction-memory-process.test.ts` |
| Transaction rollback, ambiguous/stale/protected targets, project/client/run binding | `tests/integration/interaction-memory.test.ts` |
| ChatGPT read/read-write, policy and DB owner boundaries | `tests/integration/chatgpt-capture.test.ts`, `tests/integration/chatgpt-mcp.test.ts` |
| Real concurrent writer and dropped-response recovery in the test apparatus | `tests/ci/interaction-fault-smoke.mjs` |

The fault harness forwards original requests and results. The conflict case
updates the candidate through the real domain API in a separate writer process.
The response-loss case discards one successful response and allows the real
client to time out; it does not fabricate a tool error. A deterministic client
proves the apparatus works. Only a live model trial can prove that the model
chooses a correct retry.

The response-loss live trial explicitly authorizes one retry of the same save
in its natural user message; it does not supply an operation ID or payload.
This avoids requiring the model to violate the general instruction against
unchanged retries. Its isolated server uses the documented
[`tool_timeout_sec`](https://developers.openai.com/codex/config-reference/)
override of 10 seconds, within the existing 180-second session budget. The
baseline with an unspecified tool timeout remained pending until the harness
deadline, so it did not measure retry behavior. Normal scenarios retain the
client's timeout setting.

## Live correction scenarios

Build first, then run with an already-authenticated compatible Codex CLI:

```bash
KIOKUKO_SMOKE_SCENARIO=correction npm run test:interaction:live
```

`KIOKUKO_SMOKE_CODEX` selects an existing executable. Optional
`KIOKUKO_SMOKE_MODEL` and `KIOKUKO_SMOKE_REASONING_EFFORT` pin the tested settings.
Unspecified settings are recorded as client defaults, not invented model IDs.
The CLI version, selected settings, base SHA, working-tree patch hash, untracked
source hashes and bundled Skill hashes are recorded. A server-side model
snapshot is not claimed when the client does not expose it.

`all`, `global` and `project` retain their existing selection meaning;
`correction` is an explicit additional suite. Build-dependent commands must run
serially before the live suite because builds replace `dist`.

The correction suite contains 13 independent trials: A→B and A→B→C three times
each (two fixed prompts and one paraphrase), first capture of a correction,
ambiguous target, conditional coexistence, disabled capture, revision conflict,
lost response and project isolation. Each trial uses a separate database. Each
model invocation is fresh and cannot receive previous receipts, IDs, answers or
DB snapshots from the evaluator. For ambiguity, the clarification is restated as
a self-contained new user message; this verifies target selection after an
explicit clarification, not a resumed application's conversation UX.

The model sees only normal bundled guidance, real MCP tools and natural user
messages. Native memory, plugins, web search, handoff storage and multi-agent
features are disabled in the subprocess configuration. These are test-local
settings; personal configuration and real memory are not rewritten.

The printed evidence directory contains session inputs, events, answers, final
DB snapshots and `summary.json`. The evidence excludes reasoning events.
Tool success requires a real enabled/current receipt, correct identity and
revision, candidate/untrusted storage and exclusion of superseded entries.
Responses must also be read against the recorded order/count/topic rubric.
`automatedResult=passed` alone is **not** end-to-end success: `answerReviewResult`
remains `not_run` until the independent reading is recorded. A substring match
or another LLM's unexamined verdict is insufficient.

All attempted trials remain recorded, including failures. Infrastructure
rejections such as an unsupported CLI/model combination stop the remaining
trials with `blocked`/`not_run`. Unknown execution failures remain `failed`.
No success-until-retry loop discards failed trials.

## Verification record (2026-10-05 JST)

- Base revision: `5f8289f5edf09a3fd37252261c6886fa0f324027`, with uncommitted changes.
- Focused provenance/root/process and checkpoint tests passed; typecheck passed.
- Final full suite with loopback permission: 1,836 tests, 1,835 passed, no
  failures, one pre-existing real tunnel-client skip.
- The sandboxed full run had 97 listener-related failures; it is retained
  separately from the permitted full run.
- Retrieval evaluation passed (110 queries, Recall@1 0.93, Recall@5 0.99).
  These are the existing synthetic-vector evaluation results, not live semantic
  or answer-quality measurements.
- Bilingual index evaluation, required sqlite-vec smoke, sample DB/Web API,
  package dry-run and global-install smoke passed.
- Standard `npm ci` succeeded in an isolated clone with network permission,
  without `--ignore-scripts`. The initial sandboxed attempt failed DNS lookup.
- The default npm cache was sandbox-inaccessible; pack verification passed
  using a writable temporary cache without changing the user's cache.
- The offline embedding command verified only the pinned manifest. Actual
  embedding inference and the actual ChatGPT app are outside this validation.
- The clean Linux-container test is wired into CI. Docker is not available on
  this host's PATH, so its execution here is blocked.
- Initial live attempts using CLI 0.146.0 were rejected by the API before
  inference because the selected model required a newer CLI. Their original
  logs are preserved; they do not measure memory behavior. The harness now
  recognizes this prerequisite failure and stops subsequent trials.
- Live CLI 0.160.0 results are pending completion of the current measurement.
