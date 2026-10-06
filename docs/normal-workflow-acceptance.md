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
not TAP or JSON printed by test code. G4 recomputes pass/fail/skip/todo/cancelled
from each official leaf-completion event, checks one final summary and an ended
stream, rejects duplicate/unknown/missing IDs, and compares totals to that result. G2 builds, packs once, installs that tarball,
checks generated Skills and restart behavior, and installs the optional runtime.
Each stage retains stdout/stderr, argv/cwd/exit/signal/times and its corresponding
outcome: actual npm pack metadata/sha1/inventory, installed file hashes, deployed
Skill bytes plus public MCP selector responses, persisted verification state
before/after MCP restart, and optional package inventory/import completion. G4
compares these with the same actual tarball. `true`, correctly named commands
without outcomes, missing stages and interrupted execution cannot pass.
An optional-runtime download failure is a failure, not an approved skip. G0/G1
retain their own results when a later stage fails.

The default suite's approved inventory must be reviewed separately and frozen in
the policy. It is not learned from the result being graded. IDs include relative
file, runtime event location and test name. An optional skip must name the exact ID in
that inventory; zero tests, missing IDs, unexpected skips, todo/cancelled/failed
results and incomplete streams fail acceptance. Count changes require a newly
reviewed inventory, not editing a report to match.
A passing completion with a failure reason is contradictory even for an approved
skip, and is rejected.

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
separate realm without host objects, process, credentials, filesystem,
IPC or dynamic code generation. Intrinsics are frozen and privately bound, including collection iterator prototypes;
replacing a writable global constructor cannot change assertion serialization. Test callbacks execute
there; a trusted Node host registers their outcomes with the actual test runner.
A separate parent consumes lifecycle events and writes the result file outside
the worker's readable/writable roots. Worker stdout/stderr never supply counters.
The bridge supports synchronous top-level tests and skip/todo, including string
skip reasons and the native TODO status of tests without a callback. Assertions are
performed by the real `node:assert` / `node:assert/strict` implementation, preserving
their distinct loose/strict modes. A frozen null-prototype bridge accepts only a
bounded primitive string and returns a primitive outcome; no fixture object or
host exception crosses it. A tagged graph preserves undefined properties, numeric
special values, bigint, arrays (including holes), plain/null-prototype objects,
Sets, Maps, Dates, RegExps, sharing and cycles. Functions, symbols, typed arrays,
custom prototypes, accessors, non-enumerable custom properties, Proxy operations and unknown assertion members are
explicitly unsupported and produce FAIL_HARNESS even when a fixture catches the
error. Comparison is never replaced by JSON equality. The helper supports
equal/strictEqual, notEqual/notStrictEqual, deepEqual/deepStrictEqual,
notDeepEqual/notDeepStrictEqual, ok and fail. Unsupported imports, async tests, empty registration and premature
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
a successfully collected but unreviewed answer remains WAITING_REVIEW;
stale/unapproved/UNCERTAIN reviews yield FAIL_HARNESS; an independently
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
node scripts/run-normal-workflow-acceptance.mjs --collect-only \
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
each required core Skill individually, unique index identities, exact canonical
identity/body/package version, soul completion before memory-reasoning starts and
both completions before task_prepare or memory_recall registration. Expected bodies
come from the candidate package, not capability declarations. Every successful
ordinary recall is checked individually; multiple recalls may reuse the same
verified Soul and memory-reasoning reads without replacing either identity. AGENTS additionally
requires the matching isolated client loader receipt before the natural request;
project scenarios require actual hook observations. Duplicated reads of one Skill,
empty discovery, late reads and another session cannot prove loading.

Actual model/effort come from the isolated client's turn-context records. A
requested model is recorded as requestedModel, not observedModel. Missing or
unknown actual identity fails closed. Client version matches the exact approved
version, and G4 checks actual argv, request and measured usage against policy.
The loader accepts the observed scoped and unscoped AGENTS headings, with exact
body matching. CLI 0.153.4 records reasoning effort in collaboration settings;
conflicting legacy/current fields remain unobserved. Its stable Code Mode host
stays enabled so the model can invoke registered tools; native writes still
require the observed read-only boundary below.

**Execution-bound CLI checkpoints use an exclusive fixture executor.** Native
CLI tools run in read-only sandbox with approvals disabled. A real child-process
write probe must receive EPERM/EACCES with no file/tree change, and the isolated
client's actual turn-context must also show read-only/never. Configuration alone
is insufficient. If either proof is absent, development is FAIL_HARNESS.
The separate MCP executor owns all fixture writes through one queue. It supports
reading fixture files, writing shipping source/additive tests, and standalone
fixture test commands. OS access, arbitrary commands, background processes and
protected-file edits are not execution capabilities of that server. Explanation
requests expose only file-listing and reading tools; the controller rejects
writes and test commands even if called directly.
Only named tools on the two isolated stdio servers are preapproved; unknown
tools are not exposed and native escalation remains disabled. `agents.enabled`
is false in addition to the legacy/v2 collaboration feature flags, because separate executor instances or
interleaved MCP sessions cannot establish exclusive ownership of the fixture.
Installer-generated hooks are loaded from hooks.json once, without inline copies.
The server's public initialization instructions and writer description distinguish
its bounded controller access from native read-only tools; the command description
states its persistence guarantee. This capability declaration contains no scenario
answers and does not modify the installed AGENTS or Skill instructions.
The CLI also receives the same permission boundary through `developer_instructions`
so its native read-only policy is not mistaken for the absence of the independent
MCP writer. This declaration contains no Skill selectors, test answers or grading
hints. The frozen policy pins its hash, and G4 rejects substituted or duplicate
declarations in the actual command arguments.
Neither tool teaches expected shipping values or a scenario's test sequence.

For a test command the owner holds the queue, takes a bounded immutable tree,
runs the protected Node lifecycle supervisor on that tree, writes the command
ID/exit/signal/tree/hash/lifecycle record, fsyncs the record and directory, and
only then releases the queue and returns the receipt. G3/G4 match each receipt
against the same server session and original RPC request/response. The frozen
policy pins `executorMode: native-readonly-exclusive-fixture-v1`; development
argv must select read-only sandbox, and the actual sandbox probe is included in
the identity evidence. Missing or conflicting bindings fail the harness. Delayed CLI
stdout, immediately queued edits and consecutive events cannot change saved
Red/Green trees. Every acknowledged writer request is replayed from the original
fixture to the final tree, including its returned operation sequence and tree hash.
The first implementation edit must follow the qualifying Red checkpoint; an edit
followed by a revert cannot disappear between test snapshots. Missing, reordered
or substituted writer receipts fail closed. Both trees are independently replayed
again. A complete trace without actual Red still fails. The plain `exec --json` adapter remains
checkpointAuthority=unavailable when this executor and native boundary are absent;
its events never photograph a mutable tree. This controlled fixture execution
path is distinct from unrestricted native CLI workspace writes. The real-model
matrix must pass on this path before claiming live G3 completion.

**Desktop remains NOT_RUN.** No authoritative desktop execution/loader adapter
is implemented. CLI success cannot replace desktop scenarios. An explicit tool
access denial must not be bypassed with another automation path. If desktop is
in the approved matrix it remains required. Explanation scenarios also remain
WAITING_REVIEW after a valid collection until an approved independent review is supplied.

Missing native enforcement, executor receipts, independent reviews, protected producer settings or required desktop coverage prevents live release PASS. They do not invalidate passing
local regression or package-delivery checks.


## Collect, independently review, then finalize

`--collect-only` permits a successfully collected explanation to wait for review;
its exit 0 indicates collection only, never G3 PASS. Other failures and NOT_RUN
remain failures. `review-requests.json` contains the original answers and their
answer/tree/spec hashes. Keep the execution account and process away from review
inputs. Supply a separate JSON array of `{id, review}` for each explanation,
using the exact ordered rubric criteria, reviewer identity and hashes. Then run:

```sh
node scripts/finalize-normal-workflow-acceptance.mjs \
  --live /tmp/kiokuko-normal-live \
  --policy /path/to/frozen-policy.json --policy-hash APPROVED_HASH \
  --reviews /path/to/independent-reviews.json
```

Memory application/inapplicability, verification-definition calls, injected
selector failures and subsequent recovery are derived from paired raw RPCs. The
original client stream must have a complete, ordered thread/turn lifecycle;
its last answer, tool/turn counts, runtime and loader identity must match the
stored attempt. Replacement answers and execution-summary booleans cannot
supply these facts. Collection, finalization and G4 share this validation.

The finalizer does not rerun the model or trust previous PASS summaries. It
reopens original execution, identity, instructions, protocol, loader and trees,
rechecks policy and independently replays the oracle with the review. Exit 2 means
WAITING_REVIEW; exit 1 means invalid/failed evidence; exit 0 means all required G3
attempts passed. Valid review receipts are saved for sealing. Neither local file
permissions nor the text of a reviewer name authenticates a human by itself.

The GitHub workflow uses two separate jobs. Collection uploads
`normal-workflow-collected` (deterministic/live/policy) and removes credentials.
The second job waits at protected environment `normal-workflow-answer-review`.
The independent reviewer reads that artifact, sets the environment variable
`NORMAL_WORKFLOW_REVIEW_JSON` to the hash-bound review array, and approves that
environment. Configure required human reviewers and prevent execution-job tokens
from editing environment settings. Both environments require the independently
approved `NORMAL_WORKFLOW_POLICY_HASH`. The finalizer uses `--github-review` to
fetch the run's actual approval history and require an approved human login in
the frozen reviewer allowlist. It finalizes, seals and uploads
`normal-workflow-evidence`; only then can the producer workflow succeed. G4,
after completion, independently fetches that approval history again and checks
each answer review's identity. A bot, another environment, an unapproved name or
execution-model review JSON does not satisfy the boundary. Environment protection
and variable permissions are prerequisites, not automatically configured here.

The positive workflow regression uses synthetic execution/checkpoint/review
records and a real tarball to exercise collection → pending → review → finalizer
→ sealer → G4 fixture verification. The mock-GitHub test separately exercises the
authentication boundary. Neither is real CLI/model/CI proof.

## Raw bundle and independent G4

An approved supervisor can seal raw records using
`scripts/seal-normal-workflow-evidence.mjs`. Supply deterministic/live directories,
the frozen policy/hash, actual CI run/job IDs and an empty output directory. It
refuses pending/failed G3 summaries rather than inventing missing records.
Finalize reviews first; do not append review files to an already failed producer
run and treat it as a successful workflow.

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
