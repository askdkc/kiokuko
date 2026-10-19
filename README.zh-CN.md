# Kiokuko（记忆库）

[English](README.md) | [日本語](README.ja.md) | 简体中文 | [한국어](README.ko.md)

AI 代理的本地记忆。将偏好、决策和纠正保存在 SQLite 中，
通过 MCP 检索相关上下文。

支持 **Codex、OpenCode、Claude Code 和 Hermes Agent**。
[ChatGPT 连接目前为预览版](docs/setup-notes.zh-CN.md#chatgpt)。

## 安装

需要 Node.js **24.16.0 或更高版本**。

```bash
npm i -g kiokuko
kiokuko setup
```

重启客户端后照常使用即可。设置会配置 MCP、标准 Skill 和本地 semantic 检索。
如需跳过嵌入下载，请使用
`kiokuko setup --no-embeddings`。

从 1.0 之前的版本升级需要新数据库。
[迁移与旧配置清理](docs/breaking-changes-1.0.md)。

## 文档

<a id="setup-messages"></a>

- [入门指南（英文）](docs/getting-started.md)
- [设置、故障排查与卸载](docs/setup-notes.zh-CN.md)
- [记忆与检索（英文）](docs/concepts.md)
- [历史与代码证据（英文）](docs/history-evidence.md)
- [全部文档（英文）](docs/README.md)

保存的记忆可能有误。Kiokuko 会拒绝疑似秘密的内容，不保存完整对话。
MCP 调用取决于客户端和模型的判断。
[安全与信任（英文）](docs/security-and-trust.md)。
