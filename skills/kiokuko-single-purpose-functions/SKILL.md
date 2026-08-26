---
name: kiokuko-single-purpose-functions
description: Use whenever writing, modifying, reviewing, debugging, or refactoring code in any language or repository. Enforce one cohesive contract per function, validation at hostile boundaries, caller-owned input immutability, narrow types, deterministic domain logic, explicit safe failures, separation of persistence and external effects, and focused runnable tests. Do not create meaningless micro-functions or rewrite unrelated code.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-single-purpose-functions -->

# Single-purpose function contracts

## Objective

Build and change software by composing functions that each fulfill one explicit, testable contract.

Apply this guidance across languages, frameworks, and repositories. Typed examples are intentional: adapt their contracts to the project’s type system, validation tools, error model, persistence layer, and test framework instead of treating TypeScript syntax as a requirement.

Use it for the smallest coherent surface touched by the task. Do not turn an ordinary change into a repository-wide rewrite.

## What “one thing” means

A function does one thing when it has:

- one cohesive externally observable responsibility;
- one primary reason to change;
- one defined success result;
- one explicit set of expected failures;
- one declared effect profile.

“One thing” does not mean one statement, one branch, or the shortest possible function.

Good examples include:

- parse one untrusted request;
- normalize one validated configuration value;
- calculate one price or ranking;
- load one record through a persistence interface;
- render one output representation;
- coordinate one atomic use case.

An orchestration function may call several functions. Its single responsibility is coordinating one use case. Keep detailed policy in domain functions and external mechanics in adapters or stores.

## Project contracts outrank generic advice

Before changing code, inspect the relevant source, tests, documentation, types, error conventions, and adjacent helpers.

Preserve the repository’s established contracts unless the task explicitly changes them:

- public APIs and serialized formats;
- error types, codes, and messages;
- transaction and concurrency rules;
- ownership and mutation conventions;
- framework and dependency boundaries;
- security and privacy requirements;
- test and build commands.

Reuse a project helper when it already implements the required behavior. Do not introduce a parallel result type, validation library, database wrapper, dependency container, or architecture merely because it is familiar from another project.

## Function layers

Classify every new or materially changed function before implementing it.

### Boundary parser or validator

A boundary function receives data that is not yet trusted, including network requests, command-line input, environment variables, configuration files, database rows, files, messages, provider responses, and deserialized state.

It should:

1. bound work before expensive processing;
2. reject malformed shape, type, range, encoding, size, depth, count, or unknown fields when required;
3. avoid invoking caller-controlled getters, proxies, hooks, or serialization behavior;
4. create an owned normalized value;
5. return that value or produce one narrow, safe expected failure.

After validation, delegate to typed or otherwise constrained internal code. Do not make every internal helper revalidate the same value.

### Pure domain function

A pure domain function performs one decision, state transition, normalization, ranking, projection, or calculation over validated values.

It must not hide reads of time, randomness, environment, locale-sensitive state, mutable globals, filesystem, database, or network. Pass variable dependencies explicitly. The same explicit inputs should produce the same output.

### Persistence function

A persistence function performs one storage capability.

It should:

- use the project’s established database or storage abstraction;
- parameterize queries where applicable;
- avoid transport and presentation concerns;
- avoid network and unrelated filesystem work;
- remain transaction-agnostic unless it explicitly owns the transaction;
- validate stored data before treating it as domain state;
- preserve revision, idempotency, ordering, and identity invariants.

### Effect adapter

An adapter wraps one external capability, such as reading a file, calling a provider, obtaining time, generating an identifier, writing a response, or opening a database.

Expose the smallest capability required. Prefer a narrow function or interface over a broad service container.

### Use-case orchestrator

An orchestrator coordinates one application operation. It may combine validation, pure decisions, persistence, and adapters, but it should not absorb their detailed policies.

## Required contract

Before implementing a new function or materially changing an existing one, determine:

```text
Function:
Layer: boundary | domain | persistence | adapter | orchestrator
Responsibility:
Inputs and trust level:
Input ownership:
Success output:
Expected failures:
Other propagated failures:
External effects:
Transaction or resource ownership:
Idempotency or replay behavior:
Security and privacy constraints:
Preconditions:
Postconditions:
```

The contract may remain internal for a small change, but the implementation and tests must reflect it.

## Non-negotiable rules

### 1. Do not mutate caller-owned input

Treat parameters as immutable unless the contract explicitly transfers ownership.

- Do not modify caller-provided objects, arrays, maps, sets, buffers, collections, or records.
- Return a new value for transformations.
- Local mutation of newly allocated, unobservable data is allowed when it improves clarity or measured performance.
- Do not use shared mutable state for domain behavior.

Add an input-snapshot test when accidental mutation is plausible.

### 2. Validate values at the real trust boundary

Static types, annotations, interfaces, and schemas known only to the compiler do not validate runtime data.

Use the repository’s established validation approach. Validate external JSON, database rows, configuration, files, provider responses, and messages before converting them into domain values. Reject or explicitly handle unknown fields when the contract is closed.

Use an unconstrained type such as `unknown`, a raw byte buffer, or a generic map only at a real boundary. Internal helpers should receive constrained values.

### 3. Bound work before trust

Every externally influenced collection, string, nested object, retry loop, result set, or payload needs a justified bound.

Check limits before full traversal, expansion, hashing, serialization, proportional allocation, persistence, retrying, or returning data. Truncate only when the contract explicitly defines a preview or diagnostic field; otherwise reject oversized authoritative input.

### 4. Produce an owned snapshot

Do not retain references to hostile or caller-controlled data after validation. Copy accepted values into owned structures before canonicalization, hashing, persistence, or asynchronous use.

Where the runtime permits hostile object behavior, account for accessors, proxies, cycles, malformed text, unsupported prototypes, and non-finite numbers.

### 5. Use narrow types and exact states

- Prefer the strongest practical static analysis and type-checking mode supported by the project.
- Avoid escape hatches such as `any`, unchecked casts, suppressed diagnostics, or untyped dictionaries when a narrower representation is possible.
- Use enums, literal unions, sealed variants, value objects, or equivalent exact state models.
- Distinguish missing, null, unknown, empty, unavailable, and invalid when the protocol distinguishes them.
- Omit absent optional values rather than inventing ambiguous placeholders.
- Keep assertions adjacent to the runtime check that proves them.

### 6. Make expected failures explicit and safe

Use the project’s established error taxonomy or result convention. Choose the narrowest existing failure category.

Do not use `false`, `null`, an empty string, or a swallowed exception to represent several unrelated failures. Do not catch an error merely to hide it or continue from uncertain state.

At public boundaries:

- map internal failures to stable public behavior;
- keep details bounded and allowlisted;
- never echo credentials, tokens, private data, raw request bodies, or unsafe provider responses;
- preserve both operation and cleanup failures when both occur.

### 7. Keep domain decisions deterministic

Inject time, randomness, environment, current directory, locale, filesystem, database, network, and provider access. Use stable ordering and serialization when output participates in hashes, identities, manifests, caches, snapshots, or replay.

### 8. Preserve transaction and resource discipline

- Let one use case own the transaction or resource lifecycle.
- Keep low-level storage functions composable inside that owner.
- Do not perform network calls, user prompts, or unrelated slow work while holding a write transaction or scarce lock.
- Do not add nested transaction ownership where an outer transaction already exists.
- Treat ambiguous commit or cleanup state explicitly; do not compensate as though rollback were proven.

### 9. Preserve idempotency and compare-and-swap semantics

Bind every meaning-bearing input to request identities, expected revisions, generation tokens, content hashes, or cache keys.

- Exact replay may reuse the recorded acknowledgement.
- Reusing an identity with changed input is a conflict.
- Compare the exact observed version before mutation.
- Never silently overwrite newer or independently owned state.
- Never present partial or ambiguous cleanup as full success.

### 10. Preserve external contracts

A refactor is not behavior-preserving if it accidentally changes a machine contract.

Preserve applicable command output, exit status, API schema, HTTP status, protocol envelope, database migration history, file format, line ending, file mode, ownership marker, event order, and backward-compatibility behavior.

### 11. Keep security checks in the success path

Security validation is not optional logging. Apply required authorization, normalization, sanitization, size checks, secret detection, and path or URL restrictions before persistence or delivery.

A detected secret or invalid value must not reappear in errors, logs, hashes exposed to callers, temporary diagnostics, or responses.

### 12. Test the contract independently

Use the repository’s existing test framework and style. Cover the applicable cases:

- normal success;
- empty, minimum, maximum, and exact boundary values;
- wrong primitive type or malformed structure;
- unknown fields for closed inputs;
- each expected failure category;
- no mutation of caller-owned input;
- no secret or raw invalid-value echo;
- deterministic ordering, hashing, or replay identity;
- exact replay and changed-input conflict;
- bounded retry and non-retryable failure;
- operation-plus-cleanup failure;
- integration with the real boundary when adapter behavior changes.

Assert observable behavior, not private call order, unless ordering itself is a documented invariant.

## Required workflow

1. Read the governing repository contracts and adjacent implementation.
2. Define the smallest coherent behavior change.
3. Classify each changed function’s layer.
4. Determine its input, output, failure, effect, ownership, and replay contract.
5. Validate once at the hostile boundary and create owned data.
6. Implement deterministic policy in the pure core.
7. Add only the narrow external capability required.
8. Compose the use case without mixing detailed policies into orchestration.
9. Add a regression test for the counterexample that would disprove the contract.
10. Run the narrowest affected tests, then the repository’s documented static, type, test, build, and package checks as applicable.
11. Report what changed, what was verified, what was skipped, and any residual risk.

Do not invent commands that are absent from the repository.

## Decomposition tests

Split or redesign a function when one or more are true:

1. Its responsibility requires “and then” to join unrelated observable outcomes.
2. It validates transport data, decides policy, performs persistence, and formats a response in one body.
3. It directly uses more than one unrelated external subsystem.
4. It returns a value while mutating external state not required by its contract.
5. It owns a transaction while performing network or unrelated slow work.
6. Its pure decision can be tested only by booting unrelated infrastructure.
7. A boolean flag switches between unrelated modes.
8. Error mapping or validation policy is duplicated across layers.
9. Security, replay, or cleanup state is implicit instead of represented.

Do not split when extraction would create a meaningless one-line wrapper, scatter one atomic state machine, or obscure resource ownership.

## Prohibited shortcuts

Do not:

- claim static types prove external input is valid;
- cast external data directly into a domain type;
- weaken types merely to satisfy one inconvenient call site;
- mutate input because copying is inconvenient;
- swallow corruption, conflict, partial failure, or uncertain state;
- echo invalid or secret-like values in public failures;
- retry by matching error-message text when structured classification exists;
- run external work inside a write transaction without a documented reason;
- bypass revision, idempotency, identity, authorization, or ownership checks;
- overwrite independently owned state;
- create dozens of trivial wrappers to satisfy a function-count or line-count target;
- change public contracts as incidental cleanup;
- declare completion without naming the verification actually run.

## Completion gate

Before declaring completion, use `references/review-checklist.md`. Read `references/kiokuko-patterns.md` when examples would help; despite the historical filename, its guidance applies across languages and repositories.
