# Setup and embedding CLI contract

The npm package stays lightweight. The default setup command configures clients,
installs the pinned optional runtime when needed, downloads the verified local
model, and enables semantic retrieval:

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

To configure clients without embedding setup:

```bash
kiokuko setup --no-embeddings
```

`--no-embeddings` skips runtime checks and installation, model download, and
embedding activation/generation. It preserves existing embedding settings and
models; it does not disable an active semantic profile. `kiokuko embeddings setup`
is a compatibility entrypoint for the same implementation and accepts the same flags.

Both paths update managed MCP blocks and refresh registered-project instructions.
Unmanaged MCP identities require interactive confirmation before replacement;
non-interactive or `--dry-run --json` runs fail closed without changing them.

`boolean@3.2.0` is an upstream transitive dependency of the Transformers.js
runtime. It is not a Kiokuko dependency and is not present in the lightweight
install. On Linux, the first automatic dependency installation uses sudo
through npm. On macOS it installs into Kiokuko's package-local `node_modules`
instead of the shared npm global prefix; other platforms invoke npm directly.
Do not persist npm script permissions or use `--dangerously-allow-all-scripts`.

`kiokuko setup` installs the pinned `local-small` preset without a
separate confirmation flag. Automation uses:

```bash
kiokuko setup --preset local-small --json
```

`--dry-run` performs no download, model load, database write, or filesystem
mutation. `--offline` uses only an existing verified installation. `--replace`
allows switching profiles. `status --json` reports bounded coverage and model
state. Repeating setup reuses verified model files.

JSON keeps the invoked operation name (`setup` or `embeddings.setup`) and includes
`embeddingsSkipped`. Normal setup includes the client setup fields, semantic result,
and `projectSetup`; `--no-embeddings` returns the client setup result without a
semantic result. Dry-run reads an existing database without initializing or upgrading it.

## Uninstall

Stop clients using Kiokuko and any foreground `kiokuko serve` process before cleanup:

```bash
kiokuko uninstall --dry-run
kiokuko uninstall
# After selecting all agents and completing cleanup:
npm uninstall --global kiokuko
```

On a terminal, `uninstall` shows Codex, OpenCode, Claude Code, and Hermes Agent
with no initial selections. Up/Down moves focus, Space toggles a choice, Enter
submits, and Esc/Ctrl+C cancels without changing files. Number keys 1–4 also toggle
choices. Submitting an empty selection changes nothing. Selecting only some agents
removes their managed integrations and Skills, retaining unchecked agents and
shared memory, models, runtime files, and project bindings. Keep the npm package
after partial removal. Selecting all four agents performs complete cleanup.

For explicit selection or scripts:

```bash
kiokuko uninstall --clients opencode,claude --dry-run
kiokuko uninstall --clients opencode,claude
# Complete cleanup without a selection prompt:
kiokuko uninstall --all --dry-run
kiokuko uninstall --all
npm uninstall --global kiokuko
```

`--clients` and `--all` are mutually exclusive. Noninteractive and `--json`
deletion require one of them. A noninteractive or JSON `--dry-run` without either
option previews all agents without writing files.

Complete cleanup deletes all memory in the selected database, its sidecars, downloaded
embedding models, and runtime files. It removes Kiokuko MCP entries and managed
instruction blocks for Codex, OpenCode, Claude Code, and every Hermes profile
under the configured Hermes root. Marked standard Skills, including retired
references and the old orchestration Skill, are removed. Retired managed
OpenCode plugins and Kiokuko Stop/UserPromptSubmit hook handlers are also removed.

The database registry supplies project locations, including custom agent-file
paths from `.kiokuko.json`. Uninstall removes the managed instruction block,
the binding, and its exact `.gitignore` entry. Shared files retain other content;
standalone generated files and empty owned directories are deleted. Unmarked
Skill files and other files in a shared data directory are reported as preserved.
User-chosen backup/export destinations are not tracked and are retained.
MCP entries that cannot be identified as Kiokuko-managed are excluded from
uninstall: their configuration files are retained unchanged and reported as
`preserved` with a reason. Cleanup of other artifacts continues, including the
final npm removal command. Invalid configuration syntax still rejects the plan.

Use the same `KIOKUKO_DATA_DIR`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, XDG variables,
and `HERMES_HOME` as setup. Uninstall does not search the home directory or discover
previous environment overrides. Missing registered project roots are reported;
unregistered copies and projects from an unavailable/deleted database cannot be
discovered automatically.

`--dry-run` validates the plan without changing files; `--json` emits the normal
envelope with `clients`, `scope` (`all`, `clients`, or `none`), `files`,
`missingProjects`, `dryRun`, and `npmCommand`. `npmCommand` is `null` for partial
or empty selections. A live instance,
embedding setup lock, malformed configuration, mismatched project binding, or
symbolic link rejects cleanup. The full plan is validated before mutation.
Filesystem failures during application return `PARTIAL_FAILURE` with completed
paths and the cause. Changes already applied are not rolled back; keep the npm
package, resolve the problem, and rerun. The database is deleted after client and
project cleanup, so a failed configuration edit retains the registry for retry.

After complete cleanup, the human success output ends with `npm uninstall --global kiokuko`. Uninstall
does not execute npm, remove the running package, or request sudo itself.
