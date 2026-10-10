# Recording Kiokuko sessions with AgenticReplay

Use [AgenticReplay](https://github.com/askdkc/AgenticReplay) to record the model
API traffic of a client connected to Kiokuko. It is an optional external tool;
Kiokuko does not install it or change your client configuration for recording.
The compatibility check targets `agenticreplay@0.1.2`.

## Check the command

If AgenticReplay is already installed, use that command:

```bash
agenticreplay --version
agenticreplay doctor
```

On a machine without it:

```bash
npm install --global agenticreplay@0.1.2
```

## Record the client

Configure the client's Kiokuko MCP connection with `kiokuko setup` first, and
restart it if needed. Run the recorder from the project being worked on, wrapping
the **host client** that sends model requests. Wrapping only `kiokuko mcp` cannot
capture the host's model traffic.

For Claude Code:

```bash
agenticreplay record claude -- -p "Use Kiokuko to recall relevant context for this project."
agenticreplay show last
agenticreplay replay last --worktree
```

Recording uses the client's existing credentials and can incur model charges.
For a host that cannot redirect its model API through a base-URL setting, such
as subscription-authenticated Codex CLI, use process-local TLS interception:

```bash
agenticreplay record exec --tls-intercept -- codex
```

For custom model API hosts, consult AgenticReplay's `--tls-hosts` and upstream
options. Start the client under the recorder; an already-running desktop client
does not inherit a new process's capture environment.

## Inspect and replay

Runs are stored under `.agenticreplay/runs/` in the recorded project. Inspect the
serialized requests to see the Kiokuko tool schemas and results the host actually
sent to its model. Provider-hidden reasoning and changes before the capture
boundary are not observable.

```bash
agenticreplay list
agenticreplay show last --json
agenticreplay replay last --worktree --json
```

Exact replay serves recorded model responses. A scratch worktree protects project
files, but does **not** roll back the Kiokuko database: tools can execute again and
write memories. Use a disposable Kiokuko data directory and client configuration
when testing write operations. Treat trace bodies and filesystem snapshots as
sensitive; review them before sharing. Kiokuko memories can appear in model
requests even when they are not committed project files.

## Repository compatibility check

With Node.js and AgenticReplay 0.1.2 available:

```bash
npm ci
npm run test:agenticreplay
```

The check builds Kiokuko, launches its real MCP server from a synthetic Node host,
and records two requests to a local model fixture. It verifies the captured
`task_inspect` schema and SOUL result, stops the model endpoint, then requires two
canonical exact offline matches with zero divergences, unmatched requests or live calls.
Temporary recordings, configuration and memory data are removed afterward.
Set `AGENTICREPLAY_BIN` to an executable path when the command is not on `PATH`.

This check uses no credentials or paid model calls. It proves the model transport
and real Kiokuko MCP boundary; it does not certify every client, streaming mode,
TLS interception, MCP shim, filesystem restoration or persistent memory write.
