# Agent Event Gateway HTTP/JSON v1

Kiokuko exposes a client-neutral local control-plane API. Coding agents send run lifecycle and normalized events to Kiokuko; Kiokuko commits sanitized records to SQLite and returns bounded, untrusted memory context plus deterministic recommendations.

The v1 gateway is **not** an OpenAI/Anthropic provider reverse proxy. It never requires provider credentials and does not claim to observe events that a client cannot report.

## Runtime and discovery

Start the foreground service with:

```bash
kiokuko serve [--host 127.0.0.1] [--port 0] [--json]
kiokuko server status --json
```

`kiokuko web` is the compatibility entry point for the same server composition. The service accepts loopback hosts only. On startup it creates a same-user runtime descriptor containing protocol version, PID, base URL, database fingerprint, instance ID, start time, and a random capability token. The descriptor is mode `0600`; the token must not appear in stdout, argv, `AGENT.md`, events, logs, or error responses.

All `/api/v1/*` endpoints require `Authorization: Bearer <capability-token>`. `GET /health/live` exposes only liveness; `GET /health/ready` is authenticated. CORS is not permissive.

## Write protocol

Every write requires:

- `Content-Type: application/json`
- `apiVersion: "1"`
- `Idempotency-Key: <opaque non-empty key>`
- strict unknown-field rejection
- request body at most 2 MiB

A key is scoped to the operation/run. Replaying the same key with the same canonical request returns the stored response. Reusing it with different content returns `409 CONFLICT`. Event batches are all-or-nothing and contain at most 200 events; one sanitized payload is at most 64 KiB.

Success envelope:

```json
{"apiVersion":"1","ok":true,"operation":"agent.checkpoint","data":{},"meta":{}}
```

Failure envelope:

```json
{"apiVersion":"1","ok":false,"operation":"agent.checkpoint","error":{"code":"VALIDATION_ERROR","message":"...","details":{}}}
```

The server never includes an auth token, matched secret, raw request, hidden reasoning, or internal stack in an error. Queue saturation returns `429` with `Retry-After`; unavailable storage returns `503`; validation returns `400`; authentication returns `401`; not found returns `404`; idempotency/source-ID conflict returns `409`.

## Lifecycle endpoints

### Open

`POST /api/v1/agent/runs`

Creates a ledger run, an Akinator intake session, and their one-to-one `run_intakes` link in one application transaction. Workspace is fixed here and is immutable for the rest of the run. Client-supplied coverage is stored exactly; Kiokuko does not upgrade it.

If intake needs an answer, the run remains `intake`, the response includes only the current question and no memory context. A client must present that question to the user without inventing an answer. A finalized `ready` or bounded `exhausted` intake moves the run to `active` and permits initial context delivery.

### Answer intake

`POST /api/v1/agent/runs/:runId/intake/answers`

Accepts only the currently outstanding question ID. The answer, intake transition, lifecycle event, and run status transition are atomic. Exact retry returns the same response. A finalized profile is immutable; later task-understanding changes are appended as `task_profile.revised` events.

### Append events

`POST /api/v1/agent/runs/:runId/events`

The server preserves source event IDs/sequences and assigns a contiguous local sequence. The canonical event type and optional client `sourceType` are both stored. Non-intake events are rejected while the run is `intake`. Terminal runs reject new events except exact idempotent replay.

### Checkpoint

`POST /api/v1/agent/runs/:runId/checkpoints`

Atomically appends the included events, then projects state through the committed cursor. Retrieval and optional official-source network work happen after the write transaction and outside the bounded write queue. The response contains accepted cursor, projected task profile, evidence/coverage projection, a bounded context delivery, and deterministic recommendation records.

### Close, feedback, promotion

- `POST /api/v1/agent/runs/:runId/close`
- `POST /api/v1/agent/runs/:runId/feedback`
- `POST /api/v1/agent/runs/:runId/promotions`
- `POST /api/v1/context/query`

Close records a terminal status, final events/evidence, unresolved items, outcome, and explicit memory proposals. Feedback records context, recommendation, intake-question/profile, and run outcomes without automatically changing entry trust/status or the active intake policy. Promotion creates only an existing-memory `candidate` entry and records run/event/delivery/intake provenance; it never auto-promotes to `verified`.

## Read protocol

Cursor-paginated read endpoints are:

- `GET /api/v1/agent/runs?workspace=&client=&status=&cursor=&limit=`
- `GET /api/v1/agent/runs/:runId`
- `GET /api/v1/agent/runs/:runId/intake`
- `GET /api/v1/agent/runs/:runId/events?after=&limit=&type=`
- `GET /api/v1/agent/runs/:runId/context-deliveries`
- `GET /api/v1/workspaces`
- `GET /api/v1/memory/entries`

List pages are capped at 100 records. Stored memory and event content returned to agents is marked `untrusted: true` and must be checked against the current repository/runtime.

## Coverage

Each category is one of `complete`, `best_effort`, `declared`, or `unavailable`. `complete` is reserved for a versioned bridge with a clean-room contract test. Generic CLI runs normally use `declared` or `unavailable`. UI and recommendations must display incomplete coverage rather than call the ledger a complete transcript.
