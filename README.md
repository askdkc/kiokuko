# Kiokuko (Memory Store)

English | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

**Connect via MCP, recall with RAG, and store memories after each task.**

Kiokuko is external memory for AI coding agents.

It stores knowledge gained from past work in local SQLite, then searches for and passes only relevant memories to the AI in the next request.

Users do not need to paste past context into every prompt or search for memories manually. By simply using AI as usual, project-specific knowledge gradually accumulates and can be reused in the next task.

## Get started quickly

Node.js 24.16 or newer is required.
Get started easily with these two commands 💕

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup` detects supported clients that are installed and automatically configures the SQLite database and MCP connection.
Interactive setup asks whether audited community Skills may also be used as reference material; the default answer is no.
Model-facing memory enters a task only through the capability-gated `task_prepare`
and `task_answer` MCP tools. Kiokuko installs no client hook or plugin that
silently recalls memory before those calls.

After setup, launch the target AI client and use it as usual. If it is already running, quit it once and restart it.

Supported clients:

- Codex
- OpenCode
- Claude Code
- Hermes Agent

## How it gets smarter with use

```text
User request
      ↓
Search relevant past memories
      ↓
AI uses the memories to do the work
      ↓
Store reusable results and lessons
      ↓
Search again in the next request
```

Kiokuko repeats the following flow.

1. Before work, search the current project and Global memory
2. Pass only highly relevant memories to the AI
3. The AI performs the work
4. After the work, store reusable knowledge as memory
5. Reuse that memory in the next task

In other words, Kiokuko is a **RAG system that accumulates persistent memory**.

MCP connects the AI client to Kiokuko, while RAG searches for the memories needed and passes them to the AI.

## Memory is separated by project

Ordinary searches do not mix in memories from unrelated projects.

- **Project memory**
  Knowledge used only in the current repository

- **Global memory**
  Knowledge reusable across multiple projects, such as languages, frameworks, databases, and tools

Projects are automatically identified from Git remotes or paths.

To move Project memory to Global memory, review the candidate with Curator and explicitly approve it.

```bash
kiokuko curator
```

## Review your memories

The local Web UI lets you search, review, and edit saved memories.

```bash
kiokuko web
```

Open the following address in your browser.

```text
http://127.0.0.1:4173
```

The Web UI runs only in the local environment and is not exposed to external networks.
The Web UI and explicit memory CLI commands are human/operator management
surfaces. They are not model task-entry fallbacks for `task_prepare` and
`task_answer`.

## External Skills

External skill discovery is reference-only and uses `official` mode by default
during Akinator task preparation. Kiokuko verifies the current GitHub commit,
stores bounded content as untrusted candidate memory, and never installs or
executes it. Set `KIOKUKO_SKILL_DISCOVERY=off` to disable automatic discovery;
`community` remains explicit opt-in. Interactive `kiokuko setup` asks before
enabling it; batch setup can use `--skill-discovery community`.

Example commands:

```bash
kiokuko skills find svelte --official-only --json
kiokuko skills list
kiokuko skills disable sveltejs/ai-tools/svelte-code-writer
kiokuko skills refresh sveltejs/ai-tools/svelte-code-writer
```

The Web UI's External Skills screen can inspect source state and disable or
re-enable imported mappings. It has no install, script, or MCP registration action.

## Security

Kiokuko does not store full conversations.

It refuses to store content that looks like a secret, such as passwords, API keys, tokens, or private keys.

Saved memories are always treated as reference information. Current code, configuration, and execution results take precedence over past memories.

External skill discovery is a reference-only feature. Akinator uses `official`
mode by default; set `KIOKUKO_SKILL_DISCOVERY=off` to disable it or `community`
to include audited community candidates. External skills are commit-pinned,
stored as untrusted candidate references, and are never installed or executed
automatically.

## Note

Kiokuko is not a prompt interception mechanism. Automatic use depends on MCP calls from each AI client and model, so there is no guarantee that it will be called on every turn.

See the following for more detailed commands.

```bash
kiokuko --help
kiokuko setup --help
```
