# Kiokuko（记忆库）

1.0 不再支持旧数据库，请使用新数据库。参见[破坏性变更与旧配置清理](docs/breaking-changes-1.0.md)。

[English](README.md) | [日本語](README.ja.md) | 简体中文 | [한국어](README.ko.md)

**通过 MCP 连接，检索需要的记忆，并在工作后积累知识。**

Kiokuko 是面向 AI 编程代理的本地外部记忆。它把知识保存在 SQLite 中，在下一次任务中检索相关上下文，
并保存可复用的工作结果。

```text
请求 → MCP 连接 → 检索相关记忆 → 完成工作
                              ↓
                         保存可复用知识
```

记忆分为 Project、Ecosystem 和 Global。当前代码、配置和运行结果优先于历史记忆。

## 快速开始

需要 Node.js 24.16.0 或更高版本（也支持 Node.js 26.1.0 或更高版本）。

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup` 会初始化数据库、安装标准 Skill、配置 MCP 和本地 semantic 检索。
首次运行会安装嵌入运行时并下载模型。已运行的客户端请在设置后重启。
精确配置和恢复规则请参阅[英文 Getting started](docs/getting-started.md)。

只配置客户端，不安装嵌入运行时和模型：

```bash
kiokuko setup --no-embeddings
```

此选项跳过嵌入设置步骤，不更改已有的嵌入配置。

## 卸载

先退出使用 Kiokuko 的客户端和 `kiokuko serve`。

```bash
kiokuko uninstall --dry-run
kiokuko uninstall
# 选中全部代理并完成清理后，执行最后显示的命令：
npm uninstall --global kiokuko
```

↑↓ 移动，Space 切换选择，Enter 确认，Esc 取消。默认全部未选中。
仅删除所选代理的受管理配置和 Skill。**选中全部四个代理时，还会删除共享记忆数据库、嵌入模型和项目绑定**，最后显示 npm 卸载命令。部分选择会保留共享数据和 npm 包。用户内容保持不变。
脚本中使用 `kiokuko uninstall --clients opencode,claude`，完全清理使用 `kiokuko uninstall --all`。自定义路径需要使用与 setup 相同的环境变量。
详见[清理范围](docs/cli-contract.md#uninstall)。

## 主要功能

- RAG 记忆（lexical 检索，以及通过 `setup` 配置的本地 semantic 检索）
- Akinator 让模糊请求先变得具体
- 本地 Web UI 用于检查和整理记忆
- 外部 Skill 仅作为经过验证的参考，绝不自动执行

`kiokuko embeddings setup` 保留为兼容入口，与 `kiokuko setup` 执行相同流程。

它会更新 managed MCP block 和项目 instructions。替换 unmanaged identity 需要交互确认；非交互或 `--dry-run --json`
执行会在不修改配置的情况下 fail closed。详见[英文 semantic retrieval](docs/semantic-retrieval.md)。

## 支持的客户端

Codex、OpenCode、Claude Code、Hermes Agent。

## 安全性与限制

Kiokuko 不保存完整对话，并拒绝看起来像密码、API key、token 或私钥的内容。记忆只是参考信息，应以当前代码和运行结果为准。

MCP 是否调用由客户端和模型决定，**不保证每一轮都会调用 Kiokuko**。详细安全边界请看[英文 Security and trust](docs/security-and-trust.md)。

## 详细文档

请从[英文文档目录](docs/README.md)开始；其中链接到 Getting started、Concepts、Semantic retrieval、Security and trust，
以及实现者用的 architecture、database、execution-ledger 和 client-compatibility 文档。
