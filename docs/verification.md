# Repository verification

Goal: CI executes the same repository-owned verification contract as local development.
`npm run verify` runs the full applicable scope. `npm run verify -- --profile main`
and other profiles are explicitly partial. `npm test` remains a fast/focused entry.

Inspect `npm run verify:plan` before running. Each check declares its runner,
dependencies, required capability and required result in `scripts/verification.json`.
CI prepares environments, selects profiles and retains output. Missing required
capabilities are `prerequisite-missing`; unexpected skips, empty Node suites and
failed assertions are non-success. Platform exclusions are declared before execution
and recorded with a reason. Exclusions never imply a result on that platform.

Output defaults to a fresh OS temporary directory. Supply an empty directory
outside the repository with `--output`. `plan.json`, per-command logs, official
Node lifecycle reports, `progress.json`, `result.json` and the candidate archive
are retained. Reports identify source content, runtime, profile, contract and archive.

All package consumers run after a final clean build and pack, against the same
archive and hash. Installed smoke/host assertions remain the existing assertions.
The DSH core pack and Skill consumers use normal minimal installs, with no links
to the development node_modules. Changes during verification are `stale`; saved
results must be rechecked using `npm run verify -- --status <result.json>`.
A profile passing alone never sets `completionReady`. A stale or failed full run
must not be reported as full verification, and local results do not prove remote CI.

## Existing CI checks and common suites

The runner inventory below preserves the previous CI checks. The former DSH
`npm test` is covered by native unit/integration/e2e plus dedicated Skill delivery;
its standalone `.mjs`, Python, browser, package and evaluation checks remain explicit.

| Common check | CI profile(s) | Existing runner | Required result |
| --- | --- | --- | --- |
| verification-contract | main, semantic, record | `node --test scripts/verification-contract.test.mjs` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| typecheck | main | `npm run typecheck` | exit 0 |
| build | main, semantic, record | `npm run build` | exit 0 |
| suite | main | `node scripts/run-tests.mjs tests` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| retrieval | main | `npm run test:evaluation` | existing independent assertions finish, emit their result and exit 0 |
| sampledb | main | `npm run test:sampledb` | existing independent assertions finish, emit their result and exit 0 |
| pack-contents | main | `npm run pack:check` | exit 0 |
| installed | main | `node tests/ci/global-install-smoke.mjs` | existing independent assertions finish, emit their result and exit 0 |
| memory-index | main | `node --import tsx --test --test-name-pattern=fixed bilingual index evaluation tests/integration/memory-index.test.ts` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| interaction-fault | main | `node tests/ci/interaction-fault-smoke.mjs` | existing independent assertions finish, emit their result and exit 0 |
| clean-repository | main | `docker run --rm --network none -v {root}:/workspace:ro -w /workspace node:24-bookworm node tests/ci/repository-root-smoke.mjs` | existing independent assertions finish, emit their result and exit 0 |
| agenticreplay | record | `npm run test:agenticreplay` | existing independent assertions finish, emit their result and exit 0 |
| sqlite-vec | main, semantic | `npm run test:sqlite-vec` | existing independent assertions finish, emit their result and exit 0 |
| embedding | main, semantic | `node scripts/run-local-embedding-smoke.mjs --offline` | existing independent assertions finish, emit their result and exit 0 |

Linux, Windows, other architectures and real model quality require their own executions; Mac results do not cover them. Runtime setup is an environment prerequisite and is never installed silently by verify.
