# Agent file management

`kiokuko setup` creates or updates Codex/OpenCode global `AGENTS.md` files and
Claude Code's global `CLAUDE.md` with a Kiokuko global-memory block. `kiokuko
use` optionally creates or updates the repository's `AGENTS.md` with a
project-specific block.

If setup creates a missing project binding for a registered project, it also
adds `.kiokuko.json` to that project's root `.gitignore` when neither the plain
nor root-anchored entry is already present. This setup-only addition participates
in the same compare-and-swap and rollback boundary as the binding and project
agent file.

Existing bytes outside the block are preserved, including the human-authored
header/footer, line-ending style, and file mode. Missing markers are appended;
imbalanced, duplicated, nested, or reversed markers cause a validation error
and are not repaired automatically. Symlinks are rejected.

Repeated `setup` or `use` with unchanged content does not rewrite its target
files. `setup --dry-run` validates all target content without creating the
database, config, or instruction files.

When `kiokuko use --agent-file` changes an existing repository binding, the
new target is installed and only the exact marked block is removed from the
old target. Human bytes and file mode outside that block are preserved; a file
is deleted only when the managed block was its entire content. Malformed
markers, symlinks, concurrent file changes, or a later database-registration
failure abort the transition and conditionally restore every Kiokuko-owned
file mutation. Cleanup and restoration failures are reported rather than
ignored.

The generated instructions describe the high-level `task_prepare`,
`task_answer`, Curator, and `memory_checkpoint` MCP lifecycle. The first two are
the only model-facing task-memory entry points. Human/operator CLI and Web
inspection remain management-only and are not a fallback for a client that
cannot satisfy the task capability gate. Setup writes no client hooks or
plugins, and does not require shell event streaming.

The instructions require one new bounded opaque `requestId` per logical user
request and permit reusing it only for an exact transport retry. Identical task
text in a later request still gets a new ID. Reusing an ID with changed bound
input conflicts, and `client.sessionId` is not accepted as a substitute.
The normalized context budget is also bound at preparation and must be repeated
unchanged by `task_answer`.

For actionable build/debug memory, generated instructions treat catalog
availability as only the gate, not proof of compliance. The client must read the
available local `memory-reasoning` Skill before modifying code and convert
recalled claims that affect the task into verified premises, falsifiable
invariants, concrete counterexamples, and regression tests.
