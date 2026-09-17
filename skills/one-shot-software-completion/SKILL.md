---
name: one-shot-software-completion
description: Required before planning or implementing any code change, including small fixes, tests and UI. Read this compact core; load references only for concrete risks.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: one-shot-software-completion -->

<!-- kiokuko:runtime contract -->
# One-Shot Software Completion

Deliver the user's observable result, not an isolated patch. One-shot is a
delivery goal, not a promise of success in one turn or extra authorization.

## Activation and context

For every coding request, including minimal/YAGNI work, apply this entire core
before code-changing planning or implementation. Follow `kiokuko-soul` and host
intake, scope and permissions; this Skill grants no extra agents or continuation.
Reuse the unchanged full core already in active context, including host-supplied
text. Read it when absent, changed or lost to compaction; a summary or capability
listing is insufficient. Reuse the existing plan and evidence, not extra checklists.

## Completion contract

1. Define the observable result. Resolve routine choices from current repository
   evidence; ask only about consequential uncertainty in intent or authorization.
2. Trace the real entry point, callers and effects. Include required wiring,
   delivery steps and checks; preserve unrelated work and compatibility.
3. Make the smallest complete change. Handle relevant boundaries, errors,
   security and resource ownership. Define expected results before implementation;
   add regression coverage for material behavior, reuse adequate existing checks.
4. Run required checks and focused verification through the changed entry point.
   Broaden for shared contracts; rerun checks invalidated by edits. A helper test
   alone does not prove delivery. Never weaken checks to hide failure.
5. Review the complete diff, including new files. Report behavior, checks/results,
   assumptions and unverified paths. Distinguish source from deployed/runtime
   evidence. Continue authorized work; stop only on completion or a concrete blocker.

## Read only for the current risk

A bounded change with clear callers and checks needs only this core. Otherwise
read the matching reference, one at a time; never preload the set or reread merely
because the phase changed. Select repository excerpts by relevant symbols/ranges.

| Read when | Reference |
| --- | --- |
| Scope, callers or integration are unclear | [Discovery](references/discovery-and-scope.md) |
| Inputs, effects, lifetime or compatibility change | [Boundaries](references/boundaries-and-lifecycle.md) |
| Evidence or delivery is uncertain | [Verification](references/verification-and-completion.md) |
| A check fails or progress stalls; before changing strategy | [Recovery](references/failure-recovery.md) |

Never retry an unchanged failed operation. Reference deferral does not waive the
core obligations. Follow the router's other applicable contracts without duplicating them.
<!-- /kiokuko:runtime -->
