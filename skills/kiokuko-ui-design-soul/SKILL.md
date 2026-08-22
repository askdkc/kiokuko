---
name: kiokuko-ui-design-soul
description: Apply HIG principles to app and web UI design, implementation, and review.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-ui-design-soul -->

# UI design soul

Use this skill when designing, implementing, or reviewing application and web interfaces. Do not invoke it for backend-only work, image generation alone, or tasks unrelated to an interface.

Treat Purpose, Agency, Responsibility, Familiarity, Flexibility, Simplicity, Craft, and Delight as decision principles, not as a mandate to copy Apple's visual style. Product requirements, the existing design system, accessibility standards, and safety and privacy requirements take precedence.

## Establish the intent

Before choosing components or styling, state or infer from evidence:

- the interface's purpose;
- the people it serves;
- their primary task;
- how they should feel while completing it.

If any of these would materially change the design and cannot be inferred, ask one focused question. Otherwise, proceed and state the assumption.

## Design the interaction contract

For every relevant action, cover the states that can occur: actionable, pressed or focused, processing, success, empty, failure, offline, permission denied, destructive confirmation, and recovered. Omit only states that are genuinely impossible.

- Give buttons immediate press and focus feedback.
- Keep asynchronous feedback in the action's context: update its label or status, show progress, and prevent accidental duplicate execution.
- Use determinate progress when completion can be measured and indeterminate progress otherwise.
- If progress stalls, explain why and identify the next action. Offer cancellation when the operation can be interrupted safely.
- Preserve input and completed work on failure. Provide a recovery path such as retry, undo, or back.
- Match confirmation strength to risk. Prefer undo for safely reversible actions; require explicit confirmation when recovery is unavailable or harm is material.
- Use motion only to clarify state, continuity, or causality. Never make animation the only carrier of information, and respect Reduced Motion.

## Adapt to the platform

For web interfaces, do not force an Apple-like appearance. Follow the existing design system, semantic HTML, WCAG 2.2, and the conventions of the target platform. Support keyboard, screen reader, touch, pointer, responsive layouts, and relevant system preferences.

Treat Delight as the combined result of task completion, confidence, recoverability, and careful detail—not as an amount of decoration.

## Deliver and verify

1. Identify the primary flow and interaction states before polishing the happy path.
2. Implement feedback and recovery beside the action that triggers them.
3. Test with real input methods and accessibility settings, not screenshots alone.
4. Report covered states, verified behaviors, and any known gaps.

Read [references/ui-checklist.md](references/ui-checklist.md) when producing or reviewing a concrete interface, when asynchronous or destructive behavior is involved, or when accessibility validation is in scope.
