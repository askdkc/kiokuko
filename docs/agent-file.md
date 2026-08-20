# Agent file management

`kiokuko use` creates or updates `AGENT.md` with a single managed block.
Existing bytes outside the block are preserved, including the human-authored
header/footer, line-ending style, and file mode. Missing markers are appended;
imbalanced, duplicated, nested, or reversed markers cause a validation error
and are not repaired automatically. Symlinks are rejected.

Repeated `use` with unchanged identity and template content does not rewrite
the binding or agent file.
