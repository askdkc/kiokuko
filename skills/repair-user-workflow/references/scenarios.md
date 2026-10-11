<!-- KIOKUKO MANAGED STANDARD SKILL: repair-user-workflow -->

# Scenario checks

Use these as review cases for the Skill's decisions, not as product fixtures or
automatic proof of model behavior. Keep framework, host and permission requirements
grounded in the target project. Only load this reference for a relevant ambiguity
or when evaluating the Skill.

| Request and supplied evidence | Expected decision / completion boundary |
| --- | --- |
| A plugin add succeeds. The old shortcut now names the right script, but cannot find the already installed host from another directory. | Activate. Trace installer, managed shortcut and host resolution. Repair the install owner to save required runtime defaults even when the script name is current. Verify normal add followed by that shortcut with no injected host location or extra global install. |
| A renamed CLI works on a fresh install. An existing shortcut still targets a retired entry; the user forbids restoring it. | Activate. Refresh owned references during the supported update, check first creation and existing state, inspect the index if a deletion is staged, and preserve the retirement. The old consumer must execute the supported entry. |
| A service update succeeds, but restart loads the old configuration. A manual service re-registration makes it work. | Activate. Identify the owner of the service definition and cache/reload boundary. Make the ordinary update refresh the managed state under its contract. Verify update and normal restart from pre-existing state. Do not remove required documented restart semantics. |
| A generated command relies on an environment variable written only to a shell rc file. The current shell still fails. | Activate. A child cannot rewrite the parent shell's environment. Persist a stable non-secret default where the consumer reads it, preserve explicit overrides, and test without sourcing the rc file as a rescue. |
| A web extension builds and an internal handler passes, but the installed UI sends a different payload. | Activate. Trace the real producer's value to the installed consumer. Exercise the public interaction using its normal payload. A helper-only test or a manually corrected request does not pass. |
| A CLI renders correctly, but quit exits abnormally while disposal hangs; owned children survive. | Activate. Verify bounded shutdown, fallback liveness and owned process identities. Keep unrelated sibling processes alive. Rendering or explaining the runtime exit code does not complete the repair. |
| A changed diagnostic makes a CI assertion fail only in the production shard. | Activate when it affects the workflow being repaired. Check the declared diagnostic contract and affected expectation, then run the real shard/environment. A development-only pass does not establish that the CI failure is fixed. |
| The user asks for a repository fix, forbids new permanent tests and release archives, and already authorized narrow external-source edits. | Proceed with the authorized owner fix and existing checks or temporary probes. Keep scope limits, use prior authorization, and distinguish a genuine denial from a malformed verification target. Do not ask for the same permission, create an archive, or replace the fix with instructions for a manual workaround. |
| A user-customized executable or symlink occupies the shortcut path. | Preserve it. A managed update must establish ownership before changing state. Successful migration of a managed command is insufficient if unrelated content is overwritten. |
| A source-only overlay works, but the real installation has not received the patch. | Report source/overlay verification precisely. Do not claim the live install, registry release or GitHub CI is fixed. Apply the already authorized source change before calling it applied. |
| “Explain what an installer shortcut does”; “draft commit messages for the verified diff”; an isolated pure-function arithmetic fix. | Do not impose this integration workflow. Answer the request, or use the ordinary coding routine for isolated logic. Read the actual staged diff if messages are explicitly for staged changes. |

## Pass criteria for authoring/review

- Applicable cases lead to the correct handoff owner and normal consumer, not an
  extra manual step, unrelated installation, or a recreated forbidden identifier.
- Evidence exercises the consumer with representative pre-existing state and
  distinguishes startup, normal operation and lifecycle termination where relevant.
- Non-triggering requests stay in scope. Unsupported hosts, permissions and
  deployment claims remain explicit rather than being papered over.
- Structural/YAML validation and a manual scenario review are labeled as such;
  neither proves independent forward-testing or future automatic invocation.
