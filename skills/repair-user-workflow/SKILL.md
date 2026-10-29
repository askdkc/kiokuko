---
name: repair-user-workflow
description: "Fix defects across installation, updates, generated configuration, shortcuts, plugins, services, or caller-to-runtime handoffs. Use when an operation succeeds but the user's next ordinary action fails, or a previous fix worked only with manual rescue steps. Verify the existing-user path and actual consumer. Do not activate for explanation-only requests or isolated logic edits without a workflow boundary."
---

<!-- KIOKUKO MANAGED STANDARD SKILL: repair-user-workflow -->

Kiokuko memory is optional. When its MCP server, connection, tools or bundled Skills are missing, disconnected or failing, skip the affected memory operation and continue the user's task from the current conversation, available tools and current evidence. Never require installation, reconnection or repeated retries before ordinary work. Report a memory-dependent result as unavailable once when relevant; never invent recalled content, a save receipt or verification. Memory-only procedures cannot block coding, planning, review, tests or the final answer. Preserve host authorization, identity and access denials and explicit user cancellation.

# Repair the user workflow

Complete the user's ordinary action through its actual consumer. A successful
installer, build, renamed file, internal function, or visible startup screen proves
only that stage. Keep the user's product, terminology, supported deployment mode,
and current authorization intact. This Skill specializes workflow integration;
reuse the project's existing coding and verification routine.

## Establish the path before choosing the fix

Treat the reported runtime failure as evidence. Inspect the selected executable,
installed artifact/version, generated or persisted state, and runtime resolver.
Keep source, built output, installed copies, running processes, staged changes,
and committed/CI revisions distinct. Read the index when the request concerns
staged files or commit messages; an unstaged deletion does not remove a staged file.

Trace only the affected path:

`ordinary user action → producer → saved/generated state → resolver → consumer → observable result`

Name the owner of each handoff and the first violated contract. Determine which
configuration, profile, interpreter, environment, working directory, and restart
boundary the consumer actually uses. “Installed successfully” must not be
reinterpreted as “needs another installation.” A caller can lose the location of
an already installed runtime.

Define success from the user's requested workflow before editing. Resolve routine
choices from current evidence; ask only when missing information changes the
result or authorization. Apply a correction immediately to the active work.

## Repair the owner of the broken handoff

- If the supported install/update operation owns a generated shortcut, service
  definition, cache, or registration, make that operation refresh existing managed
  state after an accepted successful update. A separate repair/register command
  is not completion when the ordinary operation is expected to do this itself.
- Cover both first creation and an existing installation. Include the state that
  survives the previous version, even when the filename is already current. Make
  repeat updates idempotent and preserve explicit user overrides, original state
  defaults, custom commands, and unowned files.
- Resolve runtime identity and location at the boundary that knows them. Store
  required stable, non-secret defaults in the artifact its consumer actually
  reads. Editing a shell startup file does not update an already running shell;
  the checkout directory is not necessarily the caller's project directory.
  Validate the runtime identity/entry and quote paths for the target interpreter.
- Preserve the chosen deployment model. A plugin in its host, a local runtime,
  and a global standalone executable are different contracts. Do not add a global
  installation, environment variable injection, manual file edit, or manual
  registration merely to compensate for a broken handoff.
- Follow an explicit retirement/rename decision through generated references,
  package metadata, update/restart logic, and staged content. Migrate references
  to the supported entry instead of recreating a forbidden old file. Preserve
  external identifiers and intentional historical fixtures under their own contracts.

For a genuinely required user action such as authentication or a documented
restart, verify that contract and state it. Do not invent an automatic guarantee
or silently convert a workaround into a prerequisite.

## Verify without rescuing the product

Use the normal producer and the pre-existing consumer, with representative saved
state. Reuse existing verifiers or a temporary isolated acceptance probe. Add a
permanent test only within the user's scope; a ban on test additions still permits
authorized verification. Use an existing artifact or an authorized temporary build
when sufficient. Create a new package artifact only when necessary and authorized,
and distinguish a verification fixture from a requested release deliverable.
Do not publish, reinstall a live profile, stage, commit, or expand the task merely
to obtain convenient evidence; those effects remain within the user's chosen scope.

The acceptance sequence must exercise the broken handoff, not call an internal
helper in its place. For example: normal update → existing shortcut → operation
from the caller's project. Remove test-only PATH entries, injected runtime roots,
hand-edited references, or manual registration that the user would not have.
Retain legitimate prerequisites and overrides from the actual supported contract.

Observe the intended behavior, not just status 0 or a success message. Select
relevant failure cases: old saved state, current filename with missing runtime
metadata, repeated updates, rejected updates, explicit overrides, or foreign files.
Exercise a reported startup problem through real startup, not only help/version.

When lifecycle behavior is affected, continue through the user's exit/cancel
action. Check the exit result, a bounded deadline, and owned resources/descendants.
Keep the termination fallback able to run while asynchronous cleanup is pending;
if forced termination is necessary, verify process ownership and identity and
preserve unrelated processes. Explaining an exit code or rendering a screen does
not satisfy a request for working termination.

## Check the final contract and report its limits

Run the affected existing checks under their actual CI/runtime conditions,
including production mode or the relevant shard when that changes behavior.
Keep legitimate changes to diagnostics, schemas, names, and expected tests/docs
consistent; do not weaken assertions to hide a failure. Recheck affected evidence
after a material change, without repeating unrelated suites.

Distinguish product failures, environment restrictions, malformed paths/tool
arguments, and authorization denials. Correct a demonstrably malformed operation
within the authorized scope; do not replay an unchanged failure, bypass a denial,
or ask again for permission already granted. Report any remaining blocked action
with its specific cause. A memory checkpoint or an approval bookkeeping result
is not product execution evidence.

Finish with the changed owner, the ordinary workflow actually exercised, its
observable outcome, and any unverified deployment/CI/live state. Separate a source
proposal, a temporary overlay, an applied patch, an installed artifact, and a
published release. Say a Skill/memory was saved only after a successful write;
availability and automatic-selection eligibility do not prove future application.

For ambiguous triggering or review of this Skill, read
[scenario checks](references/scenarios.md). Evaluate decisions and outcomes,
not whether an answer repeats these headings.
