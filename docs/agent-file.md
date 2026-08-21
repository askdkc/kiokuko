# Agent file management

`kiokuko setup` creates or updates Codex/OpenCode global `AGENTS.md` files and
Claude Code's global `CLAUDE.md` with a Kiokuko global-memory block. `kiokuko
use` optionally creates or updates the repository's `AGENTS.md` with a
project-specific block.

Existing bytes outside the block are preserved, including the human-authored
header/footer, line-ending style, and file mode. Missing markers are appended;
imbalanced, duplicated, nested, or reversed markers cause a validation error
and are not repaired automatically. Symlinks are rejected.

Repeated `setup` or `use` with unchanged content does not rewrite its target
files. `setup --dry-run` validates all target content without creating the
database, config, or instruction files.

The generated instructions describe the high-level `task_prepare`,
`task_answer`, and `memory_checkpoint` MCP lifecycle, with `memory_recall`
remaining available for explicit retrieval. They do not require a foreground
server, shell event streaming, hooks, or plugins.
