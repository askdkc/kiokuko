# Kiokuko 1.0 breaking changes

Kiokuko 1.0 removes enno-oduno, zenki, and goki. There is no replacement
orchestrator. Akinator intake, memory, Skill discovery, Curator, and the normal
CLI, MCP, and Web interfaces remain available.

## Database

Older databases cannot be upgraded or opened by 1.0. They are rejected without
conversion or deletion. Keep the old database and choose a new absolute directory:

```sh
export KIOKUKO_DATA_DIR="/absolute/path/to/kiokuko-1"
kiokuko init
kiokuko setup --clients codex
kiokuko doctor --json
```

Choose a new unused directory. Configure the same `KIOKUKO_DATA_DIR` in the
client process environment or MCP server environment; a terminal export alone
does not configure an already-running desktop client. Keep the old database
with its WAL/SHM files together and use the previous binary to inspect it.
There is no automatic import, reset, downgrade, or cross-major data conversion.

## Removed interfaces

- `kiokuko enno` and setup's `--enno-oduno` option.
- Every `enno_*` MCP tool and the `ennoOduno` task/setup response property.
- Controller ledger events, continuation tokens, execution leases, and advice.
- Init/setup `backupPath`, `databaseBackupPath`, and `recoveredEntries` response fields,
  Embedding setup's no-op `migration` result, and doctor
  reports specific to controller leases and historical context conversion.

The JSON envelope remains `apiVersion: "1"`. Its operation payloads follow the
new package major. Removed commands and tools fail as unsupported operations.

## Remove previously installed automation

Stop affected clients before editing their configuration. Remove only these
old Kiokuko entries, preserving other hooks and user content:

- Codex: the Stop-hook handler whose command contains
  `kiokuko enno hook --client codex` in `$CODEX_HOME/hooks.json`, or
  `~/.codex/hooks.json` when `CODEX_HOME` is unset.
- Claude Code: the Stop-hook handler containing
  `kiokuko enno hook --client claude` in the Claude config directory's
  `settings.json`. Also remove an old Kiokuko `UserPromptSubmit` handler if present.
- OpenCode: `plugins/kiokuko-enno-oduno.js` and, if present,
  `plugins/kiokuko-loop-guard.js` under its global config directory.
- Each selected client's Skill directory: the old `kiokuko-enno-oduno` directory.

Hook executables may be absolute paths; identify the `enno hook --client`
arguments as well as the executable. Setup does not clean or convert these
files. Rerun setup to update current managed instructions and supported Skills,
then restart the clients. Review conflicts before replacing any modified file.
