# Kiokuko

[English](README.md) | [日本語](README.ja.md) | 简体中文 | [한국어](README.ko.md)

Kiokuko 是面向 AI 编程智能体、与模型无关的外部记忆工具。通过一次 npm 全局安装，它会将结构化记忆保存在当前操作系统用户的 SQLite 数据库中，并通过 stdio MCP 向 Codex 和 OpenCode 提供高层级的 recall/checkpoint 工具。

## 全局安装与启用

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

npm 包名是 `@askdkc/kiokuko`，安装后的 CLI 命令名仍然是 `kiokuko`。

设置完成后，请重启 Codex 和 OpenCode。此后，全局 `AGENTS.md` 会指示智能体在处理重要工作之前调用 Kiokuko，并在产生持久性成果后写入检查点；需要工具时，全局配置会启动 `kiokuko mcp`。

`setup` 是显式且幂等的操作。npm 的 `postinstall` 永远不会修改 AI 客户端配置。现有 TOML/JSONC 设置、注释、指令内容、换行符和文件权限都会保留；Kiokuko 只管理自己的区块。

```bash
# 不写入任何内容，预览确切的目标文件和计划变更
kiokuko setup --dry-run --json

# 只配置一个客户端
kiokuko setup --clients codex
kiokuko setup --clients opencode

# 如果客户端进程未继承 npm 的 PATH，请使用可执行文件绝对路径
kiokuko setup --command /absolute/path/to/kiokuko
```

设置目标如下：

| 客户端 | MCP 配置 | 全局指令 |
|---|---|---|
| Codex | `$CODEX_HOME/config.toml` 或 `~/.codex/config.toml` | `$CODEX_HOME/AGENTS.md` 或 `~/.codex/AGENTS.md` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json` 或 `~/.config/opencode/opencode.json` | 同目录下的 `AGENTS.md` |

如果 OpenCode 的 `opencode.jsonc` 已存在，Kiokuko 会保留注释并更新该文件。如果 Codex 中已存在不受 Kiokuko 管理的 `[mcp_servers.kiokuko]` 表，设置程序不会猜测应该覆盖哪项配置，而是直接停止。

## 记忆作用域

数据库由当前操作系统用户全局共享，但普通 recall 不会搜索整个全局数据库：

- `project` 记忆会根据 `.kiokuko.json`、已知规范路径或 Git remote 自动解析。其他项目的记忆会被排除。
- `global` 记忆仅用于真正跨项目适用的偏好和经验。
- 默认的 `auto` recall 只返回当前项目与 global 记忆。
- 没有 remote 的仓库会获得由路径派生的稳定标识。自动解析时，Kiokuko 不会向仓库写入任何文件。

MCP 接口被有意保持为最小范围：

- `memory_recall`：读取有界的 project/global 上下文，并始终标记为 untrusted。
- `memory_checkpoint`：将有界的持久性条目保存为 `candidate` 和 `untrusted`；疑似密钥的内容会被拒绝。

这种自动使用由指令驱动，并不会拦截提示词。Codex 和 OpenCode 仍可能决定在某个回合不调用工具。Kiokuko 不会安装钩子、捕获完整对话，也不会静默地将记忆提升为 verified 状态。

## 开发

```bash
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## 开发环境用法

```bash
npm exec -- tsx src/bin/kiokuko.ts setup --dry-run --json
npm exec -- tsx src/bin/kiokuko.ts mcp
```

`kiokuko use` 仍可作为可选功能，用于创建可移植的显式绑定。它会创建 `.kiokuko.json` 和 `AGENTS.md` 中的托管区块；普通 MCP 使用不再需要它。

## Akinator 式知识采集

对于重要工作，`guide` 只会询问任务类型、目标和成功条件等缺失的高价值字段。随后，它会根据查询和 Bot 用途标签选择本地记忆：

```bash
kiokuko guide start "Implement the API change and add tests" \
  --workspace <workspace> --json
kiokuko guide answer <session-id> --workspace <workspace> \
  --question-id target --value src/api.ts --json
kiokuko guide answer <session-id> --workspace <workspace> \
  --question-id expected --value "All tests pass" --json
kiokuko guide context <session-id> --workspace <workspace> --json
```

如果本地检索没有产生相关条目，`guide context` 只能从以下白名单公开仓库获取当前 `main` 分支树，并将选中的 Markdown 技能或参考资料保存为 `candidate` 条目：

- https://github.com/NousResearch/hermes-agent
- https://github.com/obra/superpowers

每个导入条目都会记录其仓库、commit SHA 和源路径。这些内容是不受信任的参考资料，永远不会自动提升为 `verified`，也不会作为命令执行。重复同步通过内容哈希保持幂等。

## 本地 Web UI

启动仅限回环地址的 HTTP 服务器，即可按 Bot 用途、记忆类型和跨类别标签浏览记忆条目，并在浏览器中编辑 candidate 条目：

```bash
kiokuko web
# 打开 http://127.0.0.1:4173
```

使用 `--port 0` 可自动选择可用端口，使用 `--json` 可将所选 URL 以 JSON 输出。Web UI 不会在非回环接口上公开服务器。verified 和 superseded 条目为只读；编辑 candidate 时会使用乐观修订检查，并保留审计记录。

`bot:researcher`、`bot:builder` 和 `bot:reviewer` 等标签可以作为跨类型筛选器。点击条目或侧边栏中的标签，会显示所有匹配条目，而不受记忆类型限制。

记忆条目是未经信任的存储数据。依赖历史条目前，请验证当前文件和运行时状态。切勿存储密码、API 密钥、令牌、私钥或会话 Cookie。

本仓库不会自动发布。执行 `npm publish`、commit 和 push 均需要用户明确授权。
