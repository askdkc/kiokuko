---
name: kiokuko-single-purpose-functions
description: Use whenever writing, modifying, reviewing, debugging, or refactoring code. Apply a compact universal function contract, then route each function or WorkUnit to one to three versioned expert fragments for its actual risks.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->

# Single-purpose function router

## Outcome

Create code whose functions each own one cohesive externally observable responsibility, with explicit boundaries, effects, failures, and focused verification across languages, frameworks, and repositories.

This file is the mandatory compact index for code work. It is not a request to read every reference. Read this index completely, select the smallest sufficient expert set, and then read only those expert files.

## Universal core

Apply these invariants to every created or changed function:

1. State one contract: input, success, expected failures, effects, and observable result.
2. Give it one responsibility and one reason to change. Do not create meaningless micro-functions.
3. Validate hostile input at the boundary; keep the private core constrained by types or validated values.
4. Do not mutate caller-owned input unless mutation is the explicit API contract.
5. Make domain decisions deterministic. Keep persistence, network, filesystem, process, clock, randomness, UI, and logging effects explicit.
6. Return or throw failures intentionally. Do not silently swallow, partially succeed, or leak lower-layer accidents as the public contract.
7. Add the smallest runnable test that proves success, the important failure, and the regression being changed.
8. Preserve unrelated code and existing public behavior unless the task explicitly changes it.

Small is not the objective. Cohesion is. Keep operations together when splitting them would hide sequencing, duplicate policy, or weaken a transaction.

## MoE selection contract

For each new or materially changed function, or for the smallest WorkUnit that owns a cohesive use case:

1. classify the dominant risk;
2. select one expert ID from the table below;
3. add at most two more only when the same contract genuinely crosses those risks;
4. record a concrete reason for every selection;
5. read the selected files before implementation or review.

Do not make a new Skill per function. The function contract is the execution envelope; `expertRefs` are its mixture-of-experts dispatch. If two functions need materially different expert sets or reasons to change, split the WorkUnit or record separate function contracts inside it.

In Enno-Oduno plans, `expertRefs` is required for code-changing WorkUnits and is revision-bound. Outside Enno-Oduno, keep the same mapping in the working plan or review notes:

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

Typical selections:

- pure calculation: `code.domain.v1`;
- request parser: `code.boundary.v1` + `code.verification.v1`;
- transactional write: `code.effects.v1` + `code.protocol.v1`;
- public API repair: `code.boundary.v1` + `code.protocol.v1` + `code.verification.v1`.

## Escalation references

Read [kiokuko-patterns.md](references/kiokuko-patterns.md) only when a selected fragment needs a fuller TypeScript example. Read [review-checklist.md](references/review-checklist.md) for comprehensive code review or final verification, not for every function edit.

## Completion report

Report the function or WorkUnit contracts changed, selected expert IDs, focused verifier results, and anything not verified. A build alone does not prove boundary, failure, or interaction behavior.
