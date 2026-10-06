# Normal-workflow acceptance

G0–G2 test source and package delivery. G3 tests the real model/client. G4 verifies
raw evidence from an independently approved producer. Local harness tests,
synthetic transcripts, summary JSON and an artifact's own hash cannot establish
live acceptance.

## Deterministic checks

```sh
npm run test:normal-workflow
npm run typecheck
node scripts/run-normal-workflow-gates.mjs --output /tmp/kiokuko-normal-gates
```

Use a new or empty output directory. The gate runner records each stage separately,
including actual argv/cwd, start/end, exit/signal and before/after commit, dirty
state and source digest. G0 test counts are N/A. G1 uses Node lifecycle records,
not TAP or JSON printed by test code. G2 builds, packs once, installs that tarball,
checks generated Skills and restart behavior, and installs the optional runtime.
An optional-runtime download failure is a failure, not an approved skip. G0/G1
retain their own results when a later stage fails.

The default suite's approved inventory must be reviewed separately and frozen in
the policy. It is not learned from the result being graded. IDs include relative
file, runtime event location and test name. An optional skip must name the exact ID in
that inventory; zero tests, missing IDs, unexpected skips, todo/cancelled/failed
results and incomplete streams fail acceptance. Count changes require a newly
reviewed inventory, not editing a report to match.

Dirty-checkout results are local diagnostics. Source changes during a stage
invalidate that stage. The runner never marks a local diagnostic as release proof.

## Independent fixture oracle

The public shipping fixture specifies free shipping at 5000 or more and a fee of
500 below 5000. Its initial bug is exactly at 5000. Membership uses an optional
second boolean and preserves old calls and non-members.

Development replays the immutable Red tree, the same tests with only the requested
behavior corrected, and the final Green tree. Existing tests/spec/config remain
unchanged; only shipping source and additive tests may change. A separate behavior
oracle checks 0, 4999, 5000 and 5001, old calls and member/non-member combinations.

Fixture tests cannot run arbitrary host Node code. A trusted bridge links only
`node:test`, `node:assert/strict` (or `node:assert`) and `../shipping.mjs` into a
separate realm without host objects/functions, process, credentials, filesystem,
IPC or dynamic code generation. Intrinsics are frozen. Test callbacks execute
there; a trusted Node host registers their outcomes with the actual test runner.
A separate parent consumes lifecycle events and writes the result file outside
the worker's readable/writable roots. Worker stdout/stderr never supply counters.
The bridge supports synchronous top-level tests, skip/todo and the assertion
subset used by this fixture (equal/strictEqual, deepEqual/deepStrictEqual, ok,
notEqual, fail). Unsupported imports, async tests, empty registration and premature
termination cannot supply acceptable proof. This is a bounded fixture runner, not
a replacement for arbitrary repository test frameworks. VM isolation is combined
with a separate process, Node permissions and time/output limits.

Explanatory answers require an independent approved reviewer. The original answer
is retained; the execution model is not asked to produce grading JSON. A review
contains `schema: shipping-answer-v1`, kind, answerHash, initialHash, specHash,
reviewer, verdict, reason and ordered criteria from `ANSWER_RUBRIC` in
`scripts/lib/normal-workflow/answer-review.mjs`. It must assess each fact, including
negation and contradictions, rather than word presence. The exact answer, reviewed
fixture and rubric version are bound by hashes. PASS/FAIL/UNCERTAIN are distinct:
missing/stale/unapproved/UNCERTAIN reviews yield FAIL_HARNESS; an independently
reviewed wrong answer yields FAIL_PRODUCT. Keep reviews outside the model tree.
Synthetic review fixtures test this contract; they do not claim human or live
model evaluation occurred.

## Freeze approval before execution

Create the policy outside the model workspace from the authorized run settings,
reviewed test inventory, approved producer and approved reviewers:

```sh
node scripts/freeze-normal-workflow-policy.mjs \
  --approval /path/to/approved-run.json \
  --test-manifest /path/to/reviewed-test-inventory.json \
  --producer /path/to/approved-producer.json \
  --reviewers /path/to/approved-reviewers.json \
  --output /path/to/frozen-policy.json
```

The command refuses overwrite and prints the canonical policy hash. Independently
review and retain that hash before execution. File permissions and a self-computed
hash alone are not approval. The policy contains the exact provider/model/client
version/reasoning, clients, all scenario IDs and natural requests, one attempt per
scenario, all time/turn/tool/cost limits, rubric, reviewed test inventory and the
producer's repository/workflow/ref/immutable commit. It contains no auth secrets.
The supported cost condition remains ChatGPT subscription, USD 0 additional spend;
paid APIs are unsupported. Approval also requires an authFile, approved=true and
testCredentials=true. Explicit user authorization may designate the currently
logged-in subscription account for isolated synthetic tests; do not infer this
from the existence of credentials. The policy excludes the credential path.

A producer file has `repository`, `workflow` (repository-relative workflow path),
`ref` (branch name), and a full 40-character `commit`. Reviewer input is an array
of approved reviewer names. Inventory entries have `id` and `optionalSkip`.
Changing a model, version, client matrix, request, limit or rubric requires a new
independently approved policy/run. G4 constructs the matrix from that policy;
live summaries cannot reduce it or supply its expected hash.

## Live execution and current limits

```sh
node scripts/run-normal-workflow-acceptance.mjs --offline --require-live \
  --output /tmp/kiokuko-normal-offline
```

This must exit 1 with NOT_RUN. No model runs and offline cannot pass G3.

```sh
node scripts/run-normal-workflow-gates.mjs \
  --policy /path/to/frozen-policy.json --policy-hash APPROVED_HASH \
  --output /tmp/kiokuko-normal-gates
node scripts/run-normal-workflow-acceptance.mjs --require-live \
  --approval /path/to/approved-run.json \
  --policy /path/to/frozen-policy.json --policy-hash APPROVED_HASH \
  --candidate /tmp/kiokuko-normal-gates/candidate.json \
  --artifact /tmp/kiokuko-normal-gates/candidate.tgz \
  --output /tmp/kiokuko-normal-live
```

The live runner checks policy before reading credentials or starting a model. It
uses isolated HOME/CODEX_HOME/data and installer-generated AGENTS/Skills/hooks.
Only the approved tarball from G2 is installed; its bytes/source must match.
Workspace writes exclude the control/evidence directories and the default /tmp
exceptions. No production memories/config are loaded; credentials and raw client
rollouts are removed with the isolated controls. Private reasoning and credential
contents are not archived. Secret output stops capture. No automatic retry erases
a failed attempt.

Skill evidence requires paired tools/list request/response with required schemas,
unique call IDs within one proxy session, successful task_inspect responses for
each required core Skill, exact canonical identity/body/package version and
completion before task_prepare or memory_recall registration. Expected bodies
come from the candidate package, not capability declarations. AGENTS additionally
requires the matching isolated client loader receipt before the natural request;
project scenarios require actual hook observations. Duplicated reads of one Skill,
empty discovery, late reads and another session cannot prove loading.

Actual model/effort come from the isolated client's turn-context records. A
requested model is recorded as requestedModel, not observedModel. Missing or
unknown actual identity fails closed. Client version matches the exact approved
version, and G4 checks actual argv, request and measured usage against policy.

**Current CLI TDD proof is unavailable.** JSON stdout can be buffered after later
writes. The adapter therefore records no execution checkpoints and reports
checkpointAuthority=unavailable. Development yields FAIL_HARNESS until a trusted
executor provides an exclusive execution barrier, command ID/exit/signal,
monotonic sequence and immutable tree hash persisted before acknowledging the
boundary, with parallel writers blocked. Receiver locks, sleeps, final hashes
and model-declared snapshots do not meet this contract. The checkpoint validator
and positive replay fixtures are in place; they are not evidence that the CLI
supports that barrier. Adding such an executor is remaining integration work.

**Desktop remains NOT_RUN.** No authoritative desktop execution/loader adapter
is implemented. CLI success cannot replace desktop scenarios. An explicit tool
access denial must not be bypassed with another automation path. If desktop is
in the approved matrix it remains required. Explanation scenarios also remain
FAIL_HARNESS until an approved independent review is supplied.

These limits prevent a current live release PASS. They do not invalidate passing
local regression or package-delivery checks.

## Raw bundle and independent G4

An approved supervisor can seal raw records using
`scripts/seal-normal-workflow-evidence.mjs`. Supply deterministic/live directories,
the frozen policy/hash, actual CI run/job IDs and an empty output directory. It
preserves incomplete attempts rather than inventing missing records. Add an
approved answer-review.json to the relevant live attempt directory before sealing.

The manifest binds run/producer/job, clean candidate commit/source digest, actual
artifact and policy hashes, gate/attempt IDs and each relative raw leaf's size and
hash. Raw records include command provenance, lifecycle counts/inventory, package
stages, client execution/identity, protocol discovery/Skill responses, loader/hooks,
initial/final trees, checkpoints, original answers and independent reviews. The
verifier reopens those leaves and replays the oracle; it does not consume PASS,
oraclePassed, instructionsVerified or releaseReady from summaries. Missing,
mutated, duplicate, other-run, traversal and symlink evidence fails.

After the producer run completes, run the verifier from the independently reviewed producer checkout (not PR-controlled code):

```sh
node scripts/verify-normal-workflow-release.mjs \
  --artifact /path/to/candidate.tgz --evidence-root /path/to/evidence \
  --policy /path/to/frozen-policy.json --policy-hash INDEPENDENTLY_APPROVED_HASH \
  --trusted-run APPROVED_GITHUB_RUN_ID --trusted-artifact-id GITHUB_ARTIFACT_ID
```

G4 uses authenticated `gh api` to check the approved repository/workflow/ref/SHA,
workflow_dispatch run, successful job and artifact identity. It downloads the
artifact and verifies its GitHub-provided SHA256 digest before safe extraction.
The local manifest must match that independent download and every leaf must
match the authenticated manifest. Recomputing a local manifest does not recreate
producer authority. Archive links/devices/traversal/duplicate entries and size
expansion are rejected. This requires gh, Python 3 and tar; missing tooling is a
verification failure. Synthetic verifier fixtures can pass evidence validation
but always return releaseReady=false.

The manual workflow runs only on main and requires the environment's separately
reviewed NORMAL_WORKFLOW_POLICY_HASH. The frozen producer commit must equal the
workflow SHA. PR source cannot set that trusted hash through a dispatch input.
Repository configuration alone does not prove environment protection, approval,
execution, raw receipts or artifact authenticity. G4 cannot authenticate a job's
successful completion from inside that still-running job, so verification happens
afterward. This change does not configure secrets/environment protections, dispatch
CI, publish, push, merge or certify the running client.
