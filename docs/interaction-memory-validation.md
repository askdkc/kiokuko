# Interaction memory validation

Validated locally on 2026-09-19, macOS arm64, Node.js 26.5.0. These are source and
isolated-install results, not a published release or an update to a running client.

## Automated checks

- TypeScript type checking, build, and the 1,685-test unit/integration suite pass.
- Retrieval evaluation: 110 queries, Recall@1 0.93, Recall@5 0.99, semantic-only
  Recall@5 0.95, zero scope leaks, zero false-negative deliveries. These use the
  existing deterministic evaluation corpus, not a claim about model behavior.
- Package dry-run includes migration 003, the two tools, updated Skills, templates,
  and documentation. Isolated global installation verifies bundled Skill setup
  across Codex, Claude Code, OpenCode, and Hermes.
- The schema-3 sample database passes baseline and Web API checks. A separate v2
  upgrade test verifies that old entries and revision bytes are not reclassified.
- New tests cover standalone global operation without project state, subject
  isolation, general preference injection, capability withholding, exact replay,
  restarted connections, concurrent processes, operation conflicts, corrections
  of verified memories, stale/ambiguous/protected targets, transactional failure,
  secret rejection, purge retries, candidate edits, import, and index rebuilding.
- Both vector backends apply explicit subject filters before their candidate
  limit. The regression places the matching entry behind 130 unrelated vectors.
- Project preference ranking uses `context-ranking-v7`, preventing replay of a
  context selected under the previous ranking policy. Historical deliveries remain
  readable; existing revision hashes are unchanged.

The first sandboxed suite could not bind local HTTP ports. The passing suite ran
with localhost access. Package installation used a temporary prefix and npm cache;
no user client configuration was rewritten.

## Live model behavior

| Client | Result | Evidence / limit |
|---|---|---|
| Codex CLI 0.153.4 | Passed | Two fresh ephemeral conversations, real stdio MCP and a disposable SQLite database. The model chose capture, then recalled and used the preference. |
| Claude Code 2.1.220 | Blocked before inference | The isolated `--bare` probe reported `authentication_failed` / “Not logged in”. Bare mode intentionally does not use OAuth/keychain credentials. This does not establish the login state of the normal installed profile. |
| OpenCode 1.18.31 | Blocked before inference | The isolated config/data probe reported `ProviderAuthError`: its selected Google provider had no API key. Normal-profile authentication was not copied or inspected. |
| Hermes Agent | Not run | No `hermes` executable on the test process PATH. No conclusion about installations elsewhere. |

Codex's first natural message was:

> For Japanese grammar explanations, I prefer two examples about trains before grammatical terminology.

Its `memory_capture` call created a global candidate with subject
`japanese-grammar`. The second conversation received only this new message:

> Explain the difference between は and が in Japanese grammar.

The model used query-only `memory_recall`. Its answer gave these two train examples
before explaining topic and subject terminology:

> 電車は来ました。 — “The train has arrived.”
>
> 電車が来ました。 — “A train has arrived” or “The train is here.”

Both conversations read only their local copies of the bundled Skills. The second
had no first-conversation transcript or preference in its prompt. Database checks
confirmed zero repository locations, task runs, and intake sessions. This is live
proof of capture and later influence in Codex under the tested setup; it does not
prove every-turn interception or reliability in the other clients.

Two earlier probes exposed real integration boundaries. First, noninteractive
Codex denied the write tool under its approval policy. The test now preapproves
only its disposable server's `memory_capture` operation. Second, model-generated
labels differed (“Japanese grammar explanations” vs “Japanese grammar”), causing
an exact-filter miss. Bundled guidance now favors short topic labels and query-only
recall unless exact stored labels are known. The successful probe used that guidance.
Host/client tool approval still applies; Kiokuko does not bypass it.

Reproduce the Codex probe with an already-authenticated CLI:

```bash
npm run test:interaction:live
```

The script prints its temporary evidence directory, preserves protocol events and
answers there, and fails unless capture, later recall, and the train preference in
the second answer are observed. It uses process-only configuration, disables
native memory injection, ignores user config, and never resumes an old conversation.
It does not install or log into clients. For the other clients, use the same two
natural messages in separate fresh sessions with a disposable Kiokuko database,
then verify both tool calls and the second answer before marking them passed.

Codex configuration follows the official [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
and [noninteractive mode guide](https://learn.chatgpt.com/docs/non-interactive-mode).
OpenCode isolation used its documented [CLI environment settings](https://opencode.ai/docs/cli/).

## Measured scale

The interaction benchmark seeds 10,000 synthetic global captured facts in
**in-memory SQLite**, with embeddings disabled. It uses 10 recall/duplicate-capture
samples and 3 snapshot samples; values below are local measurements, not an SLA.

| Operation | Median | p95 |
|---|---:|---:|
| Query plus explicit subject recall | 27.47 ms | 35.32 ms |
| Exact duplicate capture | 0.38 ms | 2.56 ms |
| Existing project-context snapshot hash over 10,000 relevant entries | 1,447.14 ms | 1,469.49 ms |

Seeding took 8.29 seconds. The same snapshot path rejects 10,001 entries with its
existing integrity error. The snapshot measurement is one component of project
preparation, not the duration of a full `task_prepare`. Disk latency, providers,
large receipt histories, and long-running task ledgers were not benchmarked here.

```bash
npm run test:interaction:benchmark
```
