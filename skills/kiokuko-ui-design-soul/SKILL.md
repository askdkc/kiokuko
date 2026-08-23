---
name: kiokuko-ui-design-soul
description: Prevent common UI/UX failures when designing, implementing, or reviewing interactive interfaces. Enforce perceivable feedback, adequate hit targets, explicit async states, recovery, accessibility, responsive behavior, and platform conventions using Apple HIG and WCAG principles.
---

<!-- KIOKUKO MANAGED STANDARD SKILL: kiokuko-ui-design-soul -->

# UI design soul

Use this skill when designing, implementing, modifying, or reviewing any interactive user interface.

Invoke it for work involving:

- buttons, links, menus, tabs, toolbars, forms, dialogs, sheets, popovers, lists, tables, navigation, or gestures;
- loading, saving, uploading, downloading, generation, search, synchronization, or other asynchronous behavior;
- responsive layouts;
- mobile or touch interfaces;
- keyboard, screen reader, focus, motion, contrast, or other accessibility concerns;
- destructive actions, permissions, errors, offline states, empty states, or user-created data;
- UI bugs where the implementation technically works but the user may not understand what happened.

Do not invoke it for backend-only work or tasks with no user-facing interaction.

This skill is a **UI correctness and usability quality gate**, not a request to make software visually resemble Apple products.

Use the existing product design system and the conventions of the target platform unless they conflict with accessibility, safety, data integrity, or interaction correctness.

---

# Prime directive

A UI action is not successful merely because the underlying code executed successfully.

It is successful only when the user can:

1. discover the action;
2. understand what it will do;
3. activate it comfortably;
4. perceive that activation was accepted;
5. understand what is happening while it runs;
6. recognize success or failure;
7. recover when something goes wrong;
8. continue without losing work or context.

**Invisible work is a UI failure.**

If a click, tap, key press, gesture, submit, or other user action starts work but the interface appears unchanged, treat that as a defect even when the backend is working correctly.

Do not optimize the happy path while leaving processing, error, empty, disabled, offline, permission, cancellation, or recovery states undefined.

---

# Priority order

When requirements compete, optimize in this order:

1. safety and prevention of data loss;
2. accessibility and ability to operate the interface;
3. interaction correctness and feedback;
4. preservation of user context and work;
5. platform conventions and familiarity;
6. responsiveness and perceived performance;
7. visual refinement;
8. decorative delight.

Never sacrifice the first four merely to produce a cleaner-looking interface.

---

# Core interaction invariants

Treat these as defaults that require a specific reason to violate.

## 1. Every action must produce perceivable feedback

Every user-initiated action must produce immediate perceptible feedback.

Examples include:

- pressed or active visual state;
- focus change;
- loading or busy state;
- progress;
- optimistic state change;
- navigation;
- content update;
- status text;
- system feedback such as an appropriate haptic.

A network request beginning in the background is **not feedback**.

Do not allow:

```text
idle
  -> invisible background processing
  -> eventually something happens
```

Prefer:

```text
idle
  -> pressed / activated
  -> processing
  -> success | failure | cancelled
```

The user must never have to click again merely to determine whether the first click worked.

---

## 2. Interactive targets must be easy to activate

Judge the **actual hit target**, not merely the visible icon.

A visually small icon is acceptable when padding expands its interactive region.

Use platform conventions first.

### Apple platform baseline

Prefer normal/default control sizes rather than shrinking controls to platform minimums.

| Platform | Preferred/default control size | Minimum control size |
| --- | ---: | ---: |
| iOS / iPadOS | 44×44 pt | 28×28 pt |
| macOS | 28×28 pt | 20×20 pt |
| watchOS | 44×44 pt | 28×28 pt |
| tvOS | 66×66 pt | 56×56 pt |
| visionOS | 60×60 pt | 28×28 pt |

The minimum is an exception floor, not the target for ordinary controls.

For frequently used touch controls, strongly prefer at least 44×44 pt.

### Web baseline

WCAG 2.2 AA requires pointer targets to satisfy its 24×24 CSS pixel minimum target-size criterion or an allowed exception.

Treat 24×24 CSS px as an accessibility floor, **not a desirable general button size**.

For touch-oriented controls, important actions, icon buttons, and compact mobile layouts, prefer an effective hit area around 44×44 CSS px when practical.

Also verify:

- adequate spacing between adjacent targets;
- destructive and safe actions are not easy to hit accidentally;
- edge controls remain reachable;
- controls do not require precision pointing;
- touch controls do not depend on hover;
- clickable containers have predictable boundaries.

Flag tiny icon-only buttons with tiny hit regions even if they technically satisfy the visual design.

---

## 3. Async actions require an explicit state machine

For every asynchronous action, identify the applicable states before implementation:

```text
idle
focused
pressed
processing
success
failure
cancelled
offline
permission-denied
recovered
```

Not every action needs every state, but every reachable state needs defined behavior.

At minimum, inspect:

```text
idle
  -> activation feedback
  -> processing
  -> success | failure
```

There must be no invisible transition from `idle` to `processing`.

Examples include:

- save;
- submit;
- upload;
- download;
- import;
- export;
- search;
- AI generation;
- OCR;
- synchronization;
- authentication;
- deletion;
- background jobs triggered from the UI.

---

# Immediate feedback

Give visual or otherwise accessible activation feedback immediately.

Do not wait for:

- HTTP response;
- database completion;
- AI response;
- file processing;
- server acknowledgement;
- navigation completion.

A control should feel responsive even when the requested operation is slow.

Examples:

```text
Save
```

becomes:

```text
Saving…
```

or shows a nearby activity indicator immediately after activation.

A button may enter a pressed state before any asynchronous state begins.

For operations that complete almost instantly, avoid flashing a spinner unnecessarily; immediate pressed-state feedback may be enough.

For perceptibly delayed operations, show an explicit busy state.

Do not use arbitrary delays merely to make feedback visible.

---

# Processing and progress

Keep progress feedback near the action or content it belongs to whenever practical.

Prefer local busy states over blocking the entire application.

Bad:

```text
User clicks "Generate"
Nothing changes
Request runs for 12 seconds
Result suddenly appears
```

Good:

```text
User clicks "Generate"
Button immediately becomes "Generating…"
Relevant region enters a busy state
Result appears
Busy state clears
```

While processing:

- prevent accidental duplicate execution of the same operation;
- do not disable unrelated functionality without a reason;
- communicate what is happening;
- keep completed user work visible;
- do not imply progress that the system cannot actually measure.

Use:

- determinate progress when meaningful progress is measurable;
- indeterminate progress when duration or completion percentage is unknown.

Never display fake percentage progress as though it represents real work.

If a task becomes long-running:

- explain that it is still running;
- show meaningful progress when available;
- offer cancellation when cancellation is technically safe and real;
- permit unrelated work when possible;
- tell the user if processing can continue in the background;
- provide completion feedback when the result may otherwise go unnoticed.

Do not provide a Cancel button that merely hides the UI while work continues unless that behavior is explicitly communicated.

---

# Success feedback

Success must be perceivable.

Explicit success messaging is not always necessary if the state change itself is obvious.

Examples of naturally visible success:

- a saved item immediately reflects the new value;
- a deleted item disappears and an Undo action appears;
- navigation visibly reaches the requested destination;
- an uploaded file appears in the file list.

Use explicit confirmation when the result would otherwise be ambiguous.

Avoid noisy success toasts for every trivial interaction.

Do not leave the interface in a busy or disabled state after completion.

---

# Failure and recovery

A failure must never be represented only by:

- a console error;
- a rejected promise;
- an HTTP status;
- a log entry;
- a spinner that stops;
- nothing happening.

When an action fails:

1. stop the busy state;
2. preserve user input and completed work;
3. explain what failed in user-facing language;
4. keep the explanation near the affected task when possible;
5. provide the next useful action.

Possible recovery actions include:

- Retry;
- Undo;
- Back;
- Reconnect;
- Choose another file;
- Fix highlighted fields;
- Open Settings;
- Save locally.

Do not clear a form because submission failed.

Do not discard generated or edited content merely because a subsequent save failed.

Do not replace actionable errors with vague messages such as:

```text
Something went wrong.
```

when the application knows enough to say something more useful.

Technical details may be logged separately.

---

# Preserve user context

UI updates must not unexpectedly reset the user's place.

When data reloads, state changes, or asynchronous work completes, preserve relevant context such as:

- selected item;
- current document;
- current page;
- active tab;
- expanded sections;
- scroll position;
- cursor position;
- form values;
- search query;
- filters;
- sort order;
- zoom;
- focus.

Do not reset a list, gallery, document viewer, carousel, or editor to the first item merely because underlying data was refreshed.

Do not remount large parts of the interface unnecessarily when a local state update is sufficient.

A successful operation that makes the user lose their place is still a UX defect.

---

# Prevent duplicate and stale actions

Async interfaces must account for concurrency.

Check for:

- double-click submission;
- repeated taps;
- multiple overlapping requests;
- stale responses arriving after newer responses;
- navigation while work is running;
- component unmount during requests;
- retry while the previous operation is still active.

When only the newest result is valid, prevent stale results from overwriting newer state.

When duplicate execution would be harmful, make the busy state enforce that invariant.

Do not globally lock the application merely because one control is busy.

---

# Forms and data entry

Every form should make these states clear:

```text
pristine
editing
invalid
submitting
submitted
failed
```

Apply these rules:

- visible labels are preferred to placeholder-only labeling;
- required fields must be understandable without color alone;
- validation errors must identify the affected field and explain how to fix it;
- preserve entered values after validation or server failure;
- do not validate so aggressively that the interface reports errors before the user has reasonably had a chance to enter a value;
- after failed submission, guide focus appropriately without unexpectedly stealing it;
- submitting must provide immediate busy feedback;
- prevent accidental duplicate submission;
- successful submission must have an observable result;
- keyboard submission behavior must be predictable;
- multiline input must not unexpectedly submit when the user expects a newline.

For uploads:

- show the chosen file;
- show upload state;
- show progress when measurable;
- expose failure and retry;
- define cancellation semantics;
- do not discard already completed uploads because another upload fails.

---

# Buttons and controls

A button label should describe its action.

Prefer:

```text
Save changes
Delete project
Retry upload
Create account
```

over ambiguous labels such as:

```text
OK
Yes
Continue
Do it
```

when a more specific verb is practical.

For icon-only controls:

- provide an accessible name;
- ensure the icon is understandable in context;
- provide additional discoverability where appropriate, such as a tooltip on pointer-based interfaces;
- use a sufficiently large hit target.

Do not recreate standard buttons, checkboxes, switches, links, text fields, or other controls from generic containers unless a custom implementation is genuinely necessary.

Use semantic or native controls whenever possible.

---

# Disabled and unavailable controls

A disabled control must look unavailable.

If the reason is not obvious, make the reason discoverable.

Do not create interfaces where users repeatedly activate something that silently refuses to work.

Do not rely solely on low opacity when that creates insufficient legibility or makes the state ambiguous.

Do not use disabled controls as the only way to teach requirements.

When practical, allow the user to reach the control and provide a useful explanation rather than hiding functionality with no context.

---

# Empty states

An empty state is a real application state, not leftover whitespace.

When useful, communicate:

1. what is empty;
2. why it may be empty;
3. what the user can do next.

Bad:

```text
[blank panel]
```

Better:

```text
No documents yet

Create a document or import an existing file.
[Create document] [Import]
```

Do not fabricate an action when there is genuinely nothing useful to do.

---

# Loading states

Do not make missing content look like broken content.

When content must load:

- display available content as soon as practical;
- use placeholders or skeletons when they improve continuity;
- distinguish loading from empty;
- distinguish loading from error;
- avoid unnecessary layout jumps when content arrives;
- keep unrelated interface areas usable when safe.

Do not replace a local operation with a full-screen loading state unless the entire application genuinely cannot proceed.

---

# Offline and connectivity states

Do not silently pretend network-dependent functionality is working while offline.

If work is queued locally, state that only when it is actually persisted.

If work is not preserved, do not imply that it will resume automatically.

When connectivity matters:

- expose relevant offline state;
- preserve local user work;
- provide retry or reconnection behavior;
- recover cleanly when connectivity returns.

---

# Permissions

Request permissions in context, close to the feature that requires them.

Explain why the capability is needed before or when the permission request occurs where appropriate.

If permission is denied:

- do not repeatedly trigger the same system prompt;
- explain what functionality is unavailable;
- provide an alternative if one exists;
- provide a safe route to Settings when appropriate.

Never imply that permission was granted when it was not.

---

# Destructive actions

Treat operations that can cause meaningful loss differently from ordinary actions.

Prefer **Undo** for safely reversible operations.

Use explicit confirmation when:

- the action is materially destructive;
- recovery is unavailable;
- the scope may surprise the user;
- the consequence is difficult to reverse.

Confirmation text should identify the action and consequence.

Prefer:

```text
Delete 14 documents?
This permanently removes them from this workspace.
```

with:

```text
Cancel
Delete 14 documents
```

over:

```text
Are you sure?
Cancel / OK
```

Do not make destructive controls visually or spatially easy to trigger accidentally.

Do not add confirmation dialogs to harmless actions merely out of habit.

---

# Navigation and continuity

Navigation must preserve a coherent mental model.

Check that:

- Back returns somewhere meaningful;
- closing a modal returns focus appropriately;
- tabs preserve expected state;
- reloading local data does not unexpectedly navigate;
- async completion does not move the user to another item without a reason;
- browser history works appropriately on the web;
- deep-linked content remains addressable when required.

Do not use navigation as a substitute for feedback.

---

# Responsive behavior

A responsive interface must preserve functionality, not merely avoid horizontal overflow.

At each supported size verify:

- the primary action is still visible or readily reachable;
- navigation remains usable;
- important information is not silently removed;
- required controls do not move somewhere undiscoverable;
- touch targets remain large enough;
- text remains readable;
- overlays fit within the viewport;
- fixed headers and bottom bars do not cover content;
- safe-area constraints are respected where applicable.

Desktop functionality must not simply disappear on mobile without an intentional replacement.

If a multi-pane layout collapses into a single pane, preserve the user's current item and navigation context.

---

# Keyboard interaction

All primary functionality must be usable without a pointer when the target platform supports keyboard interaction.

Verify:

- logical focus order;
- visible focus indicator;
- activation with expected keys;
- Escape behavior for dismissible overlays;
- no keyboard traps;
- menus and dialogs behave predictably;
- focus returns somewhere sensible when transient UI closes.

Do not remove focus outlines without providing an equally visible replacement.

Do not make hover the only way to reveal an essential action.

---

# Screen readers and semantics

Prefer native semantic elements and platform controls.

Every meaningful interactive element needs a programmatically determinable role and accessible name.

Communicate relevant:

- names;
- roles;
- values;
- checked or selected states;
- expanded states;
- validation errors;
- progress;
- busy states;
- status changes.

For web applications, use ARIA only when native HTML semantics are insufficient.

Do not add redundant or contradictory ARIA to native controls.

Dynamic status feedback must be available to assistive technologies without causing excessive announcements.

Do not move screen-reader or keyboard focus merely because content changed unless the movement helps the user continue the task.

---

# Contrast and non-color information

On the web, target WCAG 2.2 AA or stronger unless the project explicitly defines a stricter standard.

As a baseline:

- normal text: at least 4.5:1 contrast;
- large text: at least 3:1;
- meaningful UI component boundaries and state indicators: at least 3:1 against adjacent colors where WCAG requires it.

Do not communicate meaning only through color.

For example, an error field should not merely change from gray to red; also provide text, iconography, semantics, or another perceivable cue.

Disabled controls are treated differently by WCAG, but they must still remain understandable within the product context.

---

# Text size, zoom, and content growth

Test the interface with:

- increased text size;
- browser zoom;
- long values;
- translated strings;
- multiple-line labels;
- dynamic content.

For web interfaces, support 200% text resizing without losing required content or functionality where WCAG applies.

Do not hard-code heights that clip text merely to preserve visual symmetry.

Avoid truncating information required to complete the task.

---

# Motion and animation

Use motion to explain:

- state changes;
- hierarchy;
- continuity;
- cause and effect.

Do not use animation merely to make the interface feel active.

Animation must never be the only indication that something happened.

Respect Reduced Motion and equivalent platform accessibility settings.

When motion is reduced, preserve equivalent state information.

Avoid motion that delays interaction unnecessarily.

---

# Gestures and direct manipulation

Gestures need immediate and continuous feedback.

Do not require a custom or difficult gesture for essential functionality when a simpler alternative can be provided.

For drag-and-drop:

- show what is being dragged;
- show valid drop targets or outcomes when useful;
- communicate rejected drops;
- provide a non-drag alternative where accessibility standards require it.

A failed gesture should not make the application look frozen.

---

# Error prevention

Prevent mistakes where prevention is cheaper than recovery.

Examples:

- disable duplicate submission while the same save is in progress;
- warn before irreversible destructive actions;
- validate destructive scope;
- distinguish Delete from Cancel;
- avoid placing unrelated dangerous actions next to common actions;
- retain unsaved work when navigation can interrupt editing;
- handle stale network responses;
- prevent accidental repeated requests.

Do not add friction indiscriminately.

The goal is prevention of meaningful mistakes, not confirmation of every click.

---

# Perceived performance

Fast software that looks frozen is perceived as broken.

Slow software with clear, accurate state can remain understandable.

Improve perceived performance by:

- acknowledging input immediately;
- showing existing content before optional content;
- loading incrementally when useful;
- keeping unrelated controls available;
- avoiding unnecessary full-page reloads;
- preserving layout stability;
- avoiding repeated skeleton/loading flashes during small updates.

Never hide a slow operation behind silence.

---

# Platform adaptation

Do not interpret HIG principles as a requirement to imitate iOS on every platform.

## Apple platforms

Prefer:

- native controls;
- platform-standard interaction behavior;
- platform-standard navigation;
- system accessibility behavior;
- standard keyboard and pointer conventions;
- the normal/default target sizes for the platform.

## Web

Prefer:

- semantic HTML;
- native browser behavior where appropriate;
- the project's existing design system;
- WCAG 2.2 AA or stronger;
- responsive layouts;
- keyboard, pointer, and touch support;
- browser history and URL semantics when relevant.

## Cross-platform products

Preserve product identity while allowing interaction conventions to adapt to the platform.

Consistency does not mean forcing identical behavior where platform expectations differ.

---

# HIG decision principles

Use these as decision filters rather than decorative goals.

## Purpose

Every important element should help users accomplish something meaningful.

## Agency

Users should understand what they can do, retain control, escape when appropriate, and recover from mistakes.

## Responsibility

Protect privacy, attention, safety, and user-created work.

## Familiarity

Use established concepts and interaction conventions unless there is a strong reason not to.

## Flexibility

Support different devices, input methods, abilities, content sizes, and contexts.

## Simplicity

Make the next meaningful action clear without removing necessary information or control.

## Craft

Handle edge cases, timing, spacing, state, focus, copy, and failure with the same care as the happy path.

## Delight

Delight is the result of responsive, understandable, forgiving software — not an amount of decoration.

---

# Implementation rules for coding agents

When implementing UI, do not stop after making the happy path function.

Before editing code:

1. inspect the existing design system and reusable components;
2. identify the primary user action;
3. identify async boundaries;
4. identify destructive or data-loss risks;
5. identify platform and input expectations.

During implementation:

- use existing components before introducing near-duplicates;
- use native or semantic controls before recreating them;
- make processing state explicit;
- keep state ownership clear;
- avoid multiple unsynchronized sources of truth;
- guard against duplicate and stale requests;
- preserve user context through rerenders;
- preserve input through failures;
- avoid fake progress;
- implement cancellation only when cancellation semantics are real;
- avoid arbitrary timeouts as synchronization logic;
- do not hide failures in logs;
- do not silently swallow rejected operations.

When modifying existing behavior, check whether the change accidentally alters:

- selection;
- focus;
- scroll;
- navigation;
- active filters;
- busy state;
- error state;
- mobile layout;
- keyboard interaction.

---

# Review procedure

When reviewing a concrete UI, do not review screenshots alone.

Trace actual interaction behavior.

## Step 1 — Inventory

Identify:

- every primary interactive control;
- every async action;
- every destructive action;
- every form;
- navigation transitions;
- dialogs and overlays;
- responsive variants.

## Step 2 — Trace each action

For each action ask:

```text
Can the user discover it?
Can the user activate it comfortably?
What changes immediately after activation?
What is shown while it runs?
Can it execute twice accidentally?
What does success look like?
What does failure look like?
What happens to existing user work?
How does the user recover?
```

If any answer is undefined, treat it as a design or implementation gap.

## Step 3 — Check interaction targets

Inspect the effective clickable/tappable region, not only the artwork.

Flag:

- tiny icon buttons;
- crowded adjacent actions;
- precision-dependent targets;
- hover-only functionality;
- touch controls below platform expectations without justification.

## Step 4 — Test failure paths

Verify behavior for:

- server error;
- validation failure;
- timeout;
- offline state;
- permission denial;
- empty result;
- cancellation;
- stale response;
- repeated activation.

## Step 5 — Test accessibility

Verify as applicable:

- keyboard-only operation;
- visible focus;
- screen-reader semantics;
- accessible dynamic status;
- contrast;
- zoom/text resizing;
- Reduced Motion;
- touch target size.

## Step 6 — Test responsive behavior

Check narrow and wide layouts with real content.

Ensure functionality and context survive layout changes.

## Step 7 — Verify recovery

After every failure, cancellation, dialog dismissal, or temporary state, verify that the interface returns to a coherent usable state.

---

# Severity model

Use severity to prioritize review findings.

## BLOCKER

A defect that can cause:

- data loss;
- unintended irreversible destructive action;
- inability to complete a primary flow;
- security or privacy harm;
- inaccessible primary functionality with no alternative;
- indefinite state where the user cannot determine whether an important action worked.

Do not approve the interaction while a known blocker remains.

## MAJOR

Examples:

- click or tap starts asynchronous work with no visible feedback;
- primary control has an unreasonably small hit target;
- duplicate submission is possible;
- processing state is missing;
- error has no recovery path;
- failed action clears user input;
- rerender loses selection or returns to an unrelated item;
- primary operation cannot be completed with keyboard where keyboard support is expected;
- mobile layout hides required functionality;
- destructive action lacks appropriate protection.

These should normally be fixed before considering the interface complete.

## MINOR

Examples:

- non-critical copy ambiguity;
- inconsistent spacing;
- unnecessary animation;
- secondary-state polish;
- small discoverability improvements that do not block or mislead users.

Minor does not mean optional when several combine into a poor experience.

---

# Definition of done

Do not declare a UI task complete solely because:

- the build passes;
- the API returns success;
- the screenshot looks correct;
- the happy path works.

A UI task is complete when applicable behavior has been checked for:

- target size and comfortable activation;
- immediate action feedback;
- processing state;
- duplicate execution;
- success;
- failure;
- recovery;
- user-work preservation;
- selection/context preservation;
- empty state;
- offline behavior;
- permissions;
- destructive behavior;
- keyboard;
- screen reader semantics;
- focus;
- contrast;
- zoom/text resizing;
- Reduced Motion;
- touch and pointer;
- responsive layout.

Report:

1. what was verified;
2. what could not be verified;
3. known remaining gaps.

Never claim interaction behavior was tested if it was inferred only from source code or screenshots.

---

# Critical anti-patterns

Flag these aggressively:

```text
Click -> nothing visible -> background request
```

```text
Tiny icon -> tiny hit target
```

```text
Submit -> button remains active -> duplicate requests
```

```text
Request fails -> form resets
```

```text
Loading fails -> spinner forever
```

```text
Refresh data -> selected item resets
```

```text
Error exists only in console
```

```text
Delete -> immediate irreversible loss
```

```text
Disabled button -> no explanation
```

```text
Mobile layout -> required controls disappear
```

```text
Hover -> only way to discover an essential action
```

```text
Color -> only indication of state
```

```text
Animation -> only indication that an action occurred
```

```text
Drag gesture -> only way to perform an essential action
```

```text
Async completion -> stale response overwrites newer state
```

```text
Whole page blocked -> only one local control is actually busy
```

The underlying implementation may be technically correct in all of these cases. The user experience is not.

---

# Reference material

Read [references/ui-checklist.md](references/ui-checklist.md) when performing a detailed UI implementation or review.

When current platform requirements matter, prefer the latest official platform guidance over stale remembered values.

Primary standards:

- Apple Human Interface Guidelines
- Web Content Accessibility Guidelines (WCAG) 2.2

This skill paraphrases and operationalizes design and accessibility guidance. It does not require Apple-styled visuals and must not be treated as a substitute for checking current official requirements when exact platform compliance is material.
