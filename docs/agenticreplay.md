# Recording Kiokuko sessions with AgenticReplay

Use [AgenticReplay](https://github.com/askdkc/AgenticReplay) to record the model
API traffic of a client connected to Kiokuko. It is an optional external tool;
Kiokuko does not install it or change your client configuration for recording.
The repository declares a minimum tested AgenticReplay release in `package.json`;
`npm ci` installs the resolved release recorded in `package-lock.json`. The
recording and offline-response check asserts behavior, not a fixed release.

## Check the command

If AgenticReplay is already installed, use that command:

```bash
agenticreplay --version
agenticreplay doctor
```

For repository verification, `npm ci` provides a local recorder. For a
separate global installation, follow AgenticReplay's upstream instructions
and verify its behavior with the compatibility check below.

## Record the client

Configure the client's Kiokuko MCP connection with `kiokuko setup` first, and
restart it if needed. Run the recorder from the project being worked on, wrapping
the **host client** that sends model requests. Wrapping only `kiokuko mcp` cannot
capture the host's model traffic.

For Claude Code:

```bash
agenticreplay record claude -- -p "Use Kiokuko to recall relevant context for this project."
agenticreplay show last
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

## Inspect and verify offline

Runs are stored under `.agenticreplay/runs/` in the recorded project. Inspect the
serialized requests to see the Kiokuko tool schemas and results the host actually
sent to its model. Provider-hidden reasoning and changes before the capture
boundary are not observable.

```bash
agenticreplay list
agenticreplay show last --json
agenticreplay events last --json
```

The repository test replays recorded model responses to a fresh synthetic host
while the original provider is closed. A recorder CLI replay command is not
available in the tested current release. Use a disposable Kiokuko data directory
and client configuration when testing write operations. Treat trace bodies and filesystem snapshots as
sensitive; review them before sharing. Kiokuko memories can appear in model
requests even when they are not committed project files.

## Repository compatibility check

With Node.js and the lockfile-installed AgenticReplay available:

```bash
npm ci
npm run test:agenticreplay
```

The check builds Kiokuko, launches its real MCP server from a synthetic Node host,
and records two requests to a local model fixture. It verifies the captured
`task_inspect` schema and SOUL result, stops the model endpoint, then replays both captured responses to a fresh host with matching request
contracts and no calls to the original provider. A version-only change is accepted
when the behavior still works; missing recording behavior is rejected.
Trace readers likewise accept a new schema label only when the manifest scope,
event fields, order and any declared digest satisfy their reading contract.
Temporary recordings, configuration and memory data are removed afterward.
Set `AGENTICREPLAY_BIN` to an executable path when the command is not on `PATH`.

This check uses no credentials or paid model calls. It proves the model transport
and real Kiokuko MCP boundary; it does not certify every client, streaming mode,
TLS interception, MCP shim, filesystem restoration or persistent memory write.
