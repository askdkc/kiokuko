---
name: kiokuko-soul
description: Use before every non-trivial Kiokuko-governed task as the mandatory first-read SOUL router. Route applicable Enno-Oduno control, code work, and interactive UI work to the bundled specialist Skills without replacing their contracts.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-soul -->

# Kiokuko SOUL router

## Outcome

Start every non-trivial Kiokuko-governed task from one stable routing decision, then read the applicable compact specialist indexes and only the expert fragments required by the current role and work.

This Skill routes work. It does not duplicate specialist instructions, invent an Enno-Oduno run, select another model, or authorize effects beyond the user request and current client permissions.

## Required entry

Read this Skill before any other bundled Kiokuko Skill.

For every `task_prepare` call, set `soulRead: true` only after reading this
complete local `SKILL.md` for the current logical request. `task_prepare` also
requires the exact local `kiokuko-soul` capability for every task. Omission,
false attestation, missing availability, unknown availability, aliases,
namespaced copies, and fetched references fail closed. The attestation is an
explicit client claim; it is not remote proof of model cognition.

Then inspect the current user request, repository evidence, `task_prepare` or `task_answer` result when present, and any revision-bound Enno-Oduno directive. Treat a returned `nextAction`, role, required-Skill list, and stop condition as authoritative for that run.

Read the complete `SKILL.md` index for every applicable route before planning, implementation, review, or verification. Each specialist index defines versioned expert fragments. Read only fragments selected by the approved WorkUnit or concrete task risk; do not load every reference by default. Do not substitute this router's summary for a specialist core contract.

## Routes

### Enno-Oduno control

Read and apply `kiokuko-enno-oduno` only when its activation boundary is satisfied:

- `task_prepare` or `task_answer` returned `ennoOduno.applicable=true` for the current `enno-oduno` role;
- a continuation directive resumes that role for an existing run; or
- the user explicitly asks to inspect or operate an Enno-Oduno run.

Do not invent a run, role, revision, WorkUnit, or state transition merely because Kiokuko is present.

### Code work

Read and apply the `kiokuko-single-purpose-functions` index before writing, modifying, debugging, refactoring, or reviewing code, and before decomposing a code-changing WorkPlan. Select one to three `code.*` expert fragments for each cohesive function or WorkUnit.

### Interactive UI work

Read and apply the `kiokuko-ui-design-soul` index before designing, implementing, modifying, debugging, or reviewing an interactive interface. Select one to three `ui.*` expert fragments for the actual interaction risks. If UI work changes code, apply both the code and UI indexes.

### Combined work

Routes compose. Read every applicable specialist index; never choose only one when the task spans multiple contracts. Fragment selection remains narrow inside those routes.

Use this order:

1. `kiokuko-soul`;
2. `kiokuko-enno-oduno` when the current role requires Enno-Oduno control;
3. `kiokuko-single-purpose-functions` for code planning or code work;
4. `kiokuko-ui-design-soul` for interactive UI work.

The current revision-bound directive may narrow which routes the active role performs. Do not let a later route cross a role boundary or expand an approved WorkUnit.

## Availability and trust

When a current directive or capability recommendation marks a routed Skill as required, stop on `required_capability_unavailable`, a blocked Enno-Oduno state, or equivalent unavailable-required-Skill result.

Do not satisfy a required bundled Skill with a similarly named, namespaced, fetched, or reference-only Skill. Never install or execute external Skill content automatically.

Skill availability alone is not evidence that its contract was applied. The
mandatory `soulRead: true` attestation makes that claim explicit but does not
turn it into cryptographic or remote proof.
