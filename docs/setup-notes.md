# Setup and troubleshooting

<a id="setup-messages"></a>

### npm notices and setup errors

`install scripts not yet covered by allowScripts` means npm has no recorded
approval for those dependency scripts. `esbuild` is a build tool; `fsevents`
supports macOS file watching. The notice alone does not mean setup failed.

Run this in the package directory that produced the notice:

```bash
npm install-scripts ls
```

If it lists `esbuild` and `fsevents`, and you have reviewed and want to allow their
scripts, record approval with:

```bash
npm install-scripts approve esbuild fsevents
```

Approval updates that directory's `package.json`. For a global macOS Kiokuko
install, use the installed Kiokuko directory shown in the error; running these
commands in another project reviews and changes that project's policy.
See [npm's script approval guide](https://docs.npmjs.com/cli/v11/commands/npm-install-scripts/).

If setup ends with `Local semantic retrieval dependencies remain unavailable`
and `Cannot find package ... @huggingface/hub/index.js`, the embedding runtime
could not load and semantic setup is incomplete. Script approval is not a
confirmed fix for this import error. Report the full error and the output of
`kiokuko --version`, `node --version`, and `npm --version` when requesting help.

### Saved runtime for Codex

To keep Codex MCP and lifecycle hooks on one version while npm replaces its installation, prepare a separate runtime in a private application-data directory. Finish current work and stop Codex before changing its configuration:

```bash
kiokuko runtime-prepare --runtime-root "$HOME/Library/Application Support/Kiokuko/runtimes" --json
kiokuko setup --clients codex --no-embeddings --no-standard-skills --runtime-manifest /absolute/path/to/runtime/manifest.json --client-stopped
kiokuko runtime-diagnose --manifest /absolute/path/to/runtime/manifest.json --json
```

On Linux, use `${XDG_DATA_HOME:-$HOME/.local/share}/kiokuko/runtimes` as the runtime root. Replace the manifest example with the `manifestPath` printed by the first command. If the current Node executable depends on libraries outside its own binary, preparation fails; supply a standalone Node binary with `--node /absolute/path/to/node`. Preparation never changes client settings. The setup command verifies the saved files, updates the managed MCP and all lifecycle hooks together, and restores previous configuration files if the update fails. Restart Codex only when the diagnostic reports `readyForRestart: true`. Existing custom MCP commands are preserved and require separate migration.

An npm update alone does not switch the saved version. To upgrade, stop Codex after current work, prepare the new version, run the setup command with its new manifest, then restart. Keep the old saved directory for recovery; old versions are not deleted automatically. If the new version migrated the memory database, check database compatibility before returning to an older version. Allow several hundred megabytes per saved version, depending on Node and installed optional dependencies; check the actual directory size before keeping multiple versions.

### Repository instruction files

`kiokuko use` keeps a short, stable pointer in the repository's `AGENTS.md`
(or the configured agent file). Generated instructions live in `.kiokuko/AGENTS.md`.
Template and repository identity updates refresh that generated file; older
versioned blocks migrate to the pointer on the next use/setup refresh. Keep custom
instructions outside Kiokuko's managed markers; user text and other products'
sections are preserved.

Routine setup skips a missing root instruction file. Ordinary `kiokuko doctor`
automatically creates missing registered root/generated instruction files, in both
TTY and non-TTY use, without a confirmation prompt or an extra repair flag.
Recovery requires a matching registered repository ID, workspace, binding and
canonical path. It creates only absent files, preserves existing custom content,
and cannot restore deleted custom instructions. Permission failures, unsafe
symlinks and concurrent changes are reported for each target while other targets
continue. Missing/conflicting bindings are diagnosed rather than guessed.

```bash
kiokuko doctor
kiokuko doctor --json
kiokuko doctor --fix --repair-root /absolute/path/to/project
```

`kiokuko doctor --json` diagnoses without creating missing instructions. `--fix`
is the explicit registered-binding repair mode; `--repair-root` requires `--fix`.
Combining `--fix` with `--json` still permits that binding repair. Existing section
updates remain a separate interactive confirmation; non-TTY use does not approve
them. Missing generated instructions can also be restored by use/setup. Uninstall
removes only Kiokuko's managed regions from both files. See
[the CLI contract](cli-contract.md) for repair details.

## Uninstall

Stop clients using Kiokuko and any `kiokuko serve` process first.

```bash
kiokuko uninstall --dry-run
kiokuko uninstall
# After selecting all agents and completing cleanup, run the printed command:
npm uninstall --global kiokuko
```

Use Up/Down to move, Space to toggle, Enter to submit, and Esc to cancel. All choices start unchecked.
Only selected agents' managed settings and Skills are removed. **Selecting all four also deletes shared memory, embedding models, and managed project bindings**, then prints the npm removal command. Partial selection retains shared data and the npm package. User content is preserved.
For scripts, use `kiokuko uninstall --clients opencode,claude` or `kiokuko uninstall --all` for complete cleanup.
Use the same environment overrides as setup for custom locations. See [cleanup scope and failures](cli-contract.md#uninstall).

<a id="chatgpt"></a>

## Use with ChatGPT (preview)

Connect a personal plugin in Developer mode to save and recall memory. No store-distributed plugin is available.

1. **Prepare Kiokuko.** Use a version whose `kiokuko mcp --help` lists `--profile` and `--access`; otherwise [install from source](chatgpt.md). Run `kiokuko init` if you do not have a database.
2. **Install the Tunnel client.** On macOS, use the [official Homebrew instructions](https://github.com/openai/tunnel-client#install-with-homebrew):

   ```bash
   brew install openai/tools/tunnel-client
   tunnel-client --version
   ```

   For other operating systems, see the [official releases](https://github.com/openai/tunnel-client/releases/latest). In [Tunnel settings](https://platform.openai.com/settings/organization/tunnels), obtain a Tunnel ID associated with your ChatGPT workspace and a [runtime API key](https://platform.openai.com/settings/organization/api-keys) with Tunnels Read + Use permission.

3. **Start the connection on your computer.** Replace `<tunnel_id>` and `<runtime_api_key>` with your values.

   ```bash
   export CONTROL_PLANE_API_KEY="<runtime_api_key>"
   tunnel-client init \
     --sample sample_mcp_stdio_local \
     --profile kiokuko-chatgpt \
     --tunnel-id "<tunnel_id>" \
     --mcp-command "kiokuko mcp --profile chatgpt-memory --access read-write"
   tunnel-client doctor --profile kiokuko-chatgpt --explain
   kiokuko chatgpt run --profile kiokuko-chatgpt
   ```

   Keep it running while using the connection. In a new terminal, set the API key again and execute the final `run` command.

4. **Register in ChatGPT.** Enable **Settings → Security and login → Developer mode**. Under **Plugins → ＋**, name it `Kiokuko`, describe it as “Save and recall memory”, and choose **Connection → Tunnel** with the same ID. Select Kiokuko from the tools menu in a new conversation. [Official UI instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt)

Try: “Save this information in Kiokuko” or “Search Kiokuko for memories about [topic].” Review and approve write requests when prompted.

For search only, change `read-write` to `read` in the launch command. This does not change ChatGPT's built-in memory storage. **Live ChatGPT connection testing is pending.** [Troubleshooting](chatgpt.md)

