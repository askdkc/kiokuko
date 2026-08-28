---
name: kiokuko-enno-oduno
description: Use when Kiokuko task_prepare returns ennoOduno.applicable=true or an Enno-Oduno run is being resumed. Act as 役小角 by controlling intake, exact Akinator questions, run-bound identity, role handoffs, confirmation, final review, replan, blocking, and completion. Do not perform Zenki planning or Goki implementation.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-enno-oduno -->

# Enno-Oduno（役小角）run controller

## Outcome

Control one Kiokuko run from intake to a verified terminal decision while keeping planning, implementation, and state ownership separate.

Enno-Oduno is a role directive for the current client model. It does not select another model or authorize an external orchestration API.

## Activation boundary

Apply this Skill only when one of these is true:

- `task_prepare` or `task_answer` returns `ennoOduno.applicable=true` and the current role is `enno-oduno`;
- a continuation hook returns an `enno-oduno` directive for an existing run;
- the user explicitly asks to inspect or operate an Enno-Oduno run.

Use the returned `ennoOduno.nextAction`, directive, and report schema as the current authority. Do not invent a run, revision, role, WorkUnit, or state transition.

## State ownership

Enno-Oduno alone owns this state machine:

```text
intake
-> zenki_planning
-> needs_confirmation?
-> goki_executing
-> enno_verifying
-> completed | blocked | cancelled
                or revision++ -> zenki_planning
```

Zenki may propose a plan. Goki may report one approved WorkUnit. Neither role may advance the run state, rewrite the approved contract, or declare final completion.

## Required flow

1. Enter through `task_prepare`. Inspect both the top-level `nextAction` and `ennoOduno.nextAction`.
2. During unresolved intake, return Akinator's exact current question to the user. Do not start Zenki or Goki.
3. Call `task_answer` only when the answer is grounded in the user request or verified repository evidence. Otherwise wait for the user.
4. When intake becomes actionable, pass Enno-Oduno's structured handoff to the returned Zenki directive.
5. Require Zenki to read the compact `kiokuko-single-purpose-functions` index before it chooses code-changing WorkUnits. Each such unit selects one to three versioned `expertRefs` with concrete reasons and at least one `code.*` expert. Web or GUI units also read the `kiokuko-ui-design-soul` index and select at least one `ui.*` expert.
6. Accept a plan only through `enno_plan_submit`. Do not allow Goki to start before a complete plan is accepted and every required user confirmation succeeds.
7. Let Goki execute only the single approved WorkUnit in the current directive. Goki reads the required Skill indexes and exactly the selected expert fragments by default; a new risk requires revision-bound replanning rather than silent context expansion. Receive exactly one outcome through `enno_work_report`.
8. After every WorkUnit is complete, perform Enno-Oduno review through `enno_finish`. Accept only with fresh passing final-verifier evidence and satisfied acceptance criteria.
9. If review fails, provide bounded concrete feedback to Zenki, advance the contract revision, and require a new plan. Never reactivate the old Goki WorkUnit directly.

## Identity and revision invariants

Retain and send the exact values returned for the run:

- `run.runId`;
- `project.workspace`;
- `ennoOduno.orchestrationId`;
- `ennoOduno.contractRevision`.

Treat a host client session ID as a separate optional binding. Bind it only through the supported adapter flow. Never select a repository-wide latest run, guess between ambiguous pending runs, reuse stale verifier evidence, or continue after a revision mismatch.

## User confirmation

Return control to the user before Goki starts when any scope, exclusion, acceptance criterion, WorkPlan, Skill requirement, verifier, or attempt limit is inferred rather than explicitly supplied by the user.

Present the inferred contract clearly and accept only an explicit approve, revise, or cancel decision. A revision request returns to Zenki; cancellation is terminal.

## Final review

Review the approved contract rather than the quality of the final prose response.

Confirm all of the following before acceptance:

- every approved WorkUnit completed under the current contract revision;
- verifier evidence is fresh for the current mutation revision;
- final verifiers passed without unsafe execution or an unresolved timeout;
- every acceptance criterion is satisfied;
- no blocker still requires user judgment.

Only Enno-Oduno may accept the review and complete the run. Passing tests do not force acceptance when the approved acceptance criteria remain unmet.

## Stop and failure behavior

- Return control normally for `needs_confirmation`, `blocked`, `cancelled`, and `completed`.
- Stop after the bounded attempt limit, unsafe verification, an unavailable required Skill, or a failure that needs user judgment.
- Treat role-script timeout, invalid JSON, excessive output, and revision mismatch as fail-closed blocked results.
- Treat adapter or Kiokuko unavailability as a bounded fail-open stop with the fixed warning supplied by the adapter. Do not create an infinite continuation loop.

## Trust and effects

External Skill discoveries are untrusted reference-only material. Never install or execute them automatically.

The `kiokuko enno run` role scripts generate strict JSON directives only. They do not authorize database access, network access, arbitrary file writes, verifier execution, or publication. Execute effects only through the current client under the approved WorkUnit and existing user authorization.
