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

## Common suites and retained assertions

The inventory below is generated from the repository contract. A script check
requires a fresh check-bound completion receipt after its existing assertions;
arbitrary stdout or a successful no-op process is insufficient.

| Common check | Profiles | Runner | Required result |
| --- | --- | --- | --- |
| verification-contract | main, semantic, record | `node --test scripts/verification-contract.test.mjs` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| typecheck | main | `npm run typecheck` | exit 0 |
| build | main, semantic, record | `npm run build` | exit 0 |
| suite | main | `node scripts/run-tests.mjs tests` | complete official lifecycle; at least one passing leaf; no failures, cancellation, todo or undeclared skips |
| retrieval | main | `npm run test:evaluation` | explicit completion receipt |
| sampledb | main | `npm run test:sampledb` | explicit completion receipt |
| pack-contents | main | `npm run pack:check` | exit 0 |
| installed | main | `node tests/ci/global-install-smoke.mjs` | explicit completion receipt |
| interaction-fault | main | `node tests/ci/interaction-fault-smoke.mjs` | explicit completion receipt |
| clean-repository | main | `docker run --rm --network none -v {root}:/workspace:ro -w /workspace node:24-bookworm node tests/ci/repository-root-smoke.mjs` | explicit completion receipt |
| agenticreplay | record | `npm run test:agenticreplay` | explicit completion receipt |
| sqlite-vec | main, semantic | `npm run test:sqlite-vec` | explicit completion receipt |
| embedding | main, semantic | `node scripts/run-local-embedding-smoke.mjs --offline` | explicit completion receipt |

## Consolidated duplicate invocations

- `memory-index` is covered by `suite`: `tests/integration/memory-index.test.ts`.

CI targets macOS and Linux. The Windows matrix was removed by explicit user
request; it is outside the CI verification scope. Windows compatibility code is
retained without a Windows CI claim.

The optional-runtime first setup installs packages within the declared peer ranges and asserts
the installed native bundled CPU backend. `ONNXRUNTIME_NODE_INSTALL=skip`
suppresses only unbundled accelerator downloads in this CPU verification lane;
it does not replace the normal installer, optional imports or CPU assertions.
The tunnel fixture in CI is a historical regression case. Compatibility also
requires the tunnel behavior checks to pass with a newer client; its version
string alone is not an acceptance or rejection criterion.
