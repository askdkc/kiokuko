# Kiokuko (Memory Store)

English | [日本語](README.ja.md) | [简体中文](README.zh-CN.md) | [한국어](README.ko.md)

**Connect via MCP, recall with RAG, and store memories after each task.**

Kiokuko is external memory for AI coding agents.

It stores knowledge gained from past work in local SQLite, then searches for and passes only relevant memories to the AI in the next request.

Users do not need to paste past context into every prompt or search for memories manually. By simply using AI as usual, project-specific knowledge gradually accumulates and can be reused in the next task.

## Get started quickly

Node.js 24 or newer is required.
Get started easily with these two commands 💕

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup` detects supported clients that are installed and automatically configures the SQLite database and MCP connection.

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

## Security

Kiokuko does not store full conversations.

It refuses to store content that looks like a secret, such as passwords, API keys, tokens, or private keys.

Saved memories are always treated as reference information. Current code, configuration, and execution results take precedence over past memories.

## Note

Kiokuko is not a prompt interception mechanism. Automatic use depends on MCP calls from each AI client and model, so there is no guarantee that it will be called on every turn.

See the following for more detailed commands.

```bash
kiokuko --help
kiokuko setup --help
```
