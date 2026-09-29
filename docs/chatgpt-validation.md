# ChatGPT memory validation

Validation date: 2026-09-29. Scope: Global recall, save and correction over MCP stdio.

## Test environment

- Package: `kiokuko@1.0.11`; Node.js `26.5.0`; npm `11.17.0`; MCP SDK `1.30.0`.
- In-memory MCP and real stdio subprocesses, using disposable SQLite WAL databases.
- Installed-package tests run without optional embedding dependencies.

## Results

| Check | Result |
|---|---|
| Typecheck and build | Passed |
| Full test suite | 1,732 passed; 0 failed; 0 skipped |
| ChatGPT contract, transport, capture and write queue | 31 focused tests passed |
| Package installation | Save, exact retry and recall passed with the installed CLI |
| Read access | Only policy and recall exposed; SQL writes rejected |
| Write access | Explicit opt-in; Global candidate/untrusted memory only |
| Input and policy checks | Invalid fields, missing/stale policy and secret-like content rejected |
| Correction and retry | Revision checks, atomicity, deduplication and persistent receipts passed |
| Database boundaries | Project and Curator-managed correction targets protected; unsupported databases rejected |
| Lifecycle | Queue limit, draining accepted writes, EOF and SIGTERM checks passed |

Retrieval evaluation, required sqlite-vec smoke, sample-database checks, package
contents and the offline embedding manifest passed on the read-only baseline.
Those components were unchanged by the capture extension and were not rerun for it.
The offline manifest check did not load an embedding model.

## Not verified

- Live ChatGPT discovery, authentication, write approval and cross-conversation recall.
- Model behavior when choosing tools or handling conflicting or hostile memories.
- Remote GitHub CI and other OS/Node.js combinations.

Local tests do not establish a working ChatGPT connection. HTTP/OAuth hosting,
semantic search in this profile and plugin packaging are not implemented.

[Setup](../README.md#use-with-chatgpt-preview) · [Troubleshooting](chatgpt.md)
