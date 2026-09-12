---
name: kiokuko-single-purpose-functions
description: Use whenever writing, modifying, reviewing, debugging, or refactoring code. Apply compact function and problem-shaping contracts, then route each function or task to one to three versioned expert fragments for its actual risks.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->

# Single-purpose function router

## Outcome

Create code whose functions each own one cohesive externally observable responsibility, with explicit concepts, representation boundaries, effects, failures, and focused verification across languages, frameworks, and repositories.

This file is the mandatory compact index for code work. It is not a request to read every reference. Read this index completely, select the smallest sufficient expert set, and then read only those expert files.

## Universal core

Apply these invariants to every created or changed function:

1. State one contract: input, success, expected failures, effects, and observable result.
2. Before choosing a storage, framework, transport, or UI representation, name the user-visible or domain concept, its input and output, and information that must remain private. Keep this proportional; representation-preserving mechanical changes do not need a separate design artifact.
3. Give it one responsibility and one reason to change. Do not create meaningless micro-functions.
4. Validate hostile input at the boundary; keep the private core constrained by types or validated values.
5. Do not mutate caller-owned input unless mutation is the explicit API contract.
6. Make domain decisions deterministic. Keep persistence, network, filesystem, process, clock, randomness, UI, and logging effects explicit.
7. Return or throw failures intentionally. Do not silently swallow, partially succeed, or leak lower-layer accidents as the public contract.
8. Verify changed behavior with the smallest meaningful runnable check. Add or modify a test when it protects a material behavior, failure boundary, or regression; reuse existing coverage when sufficient, and skip implementation-mirroring tests for trivial, reversible, low-impact changes.
9. Preserve unrelated code and existing public behavior unless the task explicitly changes it.

Small is not the objective. Cohesion is. Keep operations together when splitting them would hide sequencing, duplicate policy, or weaken a transaction.

When a change spans setup, delivery, persisted state, or runtime handoffs, also apply the available `veteran-programmer-skill` before and after implementation. An isolated edit needs no additional audit.

## MoE selection contract

For each new or materially changed function, or for the smallest task that owns a cohesive use case:

1. classify the dominant risk;
2. select one expert ID from the table below;
3. add at most two more only when the same contract genuinely crosses those risks;
4. record a concrete reason for every selection;
5. read the selected files before implementation or review.

Do not make a new Skill per function. The function contract is the execution envelope; expert references identify the selected guidance. If two functions need materially different expert sets or reasons to change, record separate function contracts.

For each task, record its code, UI, test, documentation, or operations scope.
Code work requires code experts; interactive UI code work requires code and UI
experts. Design-only, test, documentation, and operations tasks select expertise
from their actual risks. Record the selection in working plan
or review notes:

```text
target -> responsibility -> expert IDs -> focused verifier
```

Do not load unselected fragments “just in case.” If repository evidence exposes a new risk, update the selection explicitly before consuming that fragment.

## Expert index

| Expert ID | Select when the contract owns | Read |
| --- | --- | --- |
| `code.boundary.v1` | parsing, validation, authorization, ownership, untrusted input | [boundaries-and-ownership.md](references/boundaries-and-ownership.md) |
| `code.domain.v1` | domain rules, state transitions, narrow types, deterministic decisions | [domain-and-types.md](references/domain-and-types.md) |
| `code.effects.v1` | database, filesystem, network, process, transaction, resource lifetime | [effects-and-data.md](references/effects-and-data.md) |
| `code.protocol.v1` | retry, idempotency, concurrency, revisions, external/public protocols | [protocols-and-idempotency.md](references/protocols-and-idempotency.md) |
| `code.verification.v1` | regression repair, test design, review, compatibility or failure evidence | [verification.md](references/verification.md) |
| `code.modeling.v1` | problem shaping, public data design, domain vocabulary, or translation between storage, API, serialization, and UI representations | [problem-shaping-and-language.md](references/problem-shaping-and-language.md) |

Typical selections:

- pure calculation: `code.domain.v1`;
- public response, DTO, or ViewModel design: `code.modeling.v1` + `code.boundary.v1`;
- domain concept or state representation: `code.modeling.v1` + `code.domain.v1`;
- request parser: `code.boundary.v1` + `code.verification.v1`;
- transactional write: `code.effects.v1` + `code.protocol.v1`;
- public API repair: `code.boundary.v1` + `code.protocol.v1` + `code.verification.v1`.

## Escalation references

Read [kiokuko-patterns.md](references/kiokuko-patterns.md) only when a selected fragment needs a fuller TypeScript example. Read [review-checklist.md](references/review-checklist.md) for comprehensive review or final verification across several code contracts. An ordinary edit inside one cohesive contract uses the focused [verification.md](references/verification.md) sequence.

## Completion report

Report the function or task contracts changed, selected expert IDs, focused verifier results, and anything not verified. A build alone does not prove boundary, failure, or interaction behavior.
