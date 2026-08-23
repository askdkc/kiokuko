# Kiokuko

[English](README.md) | [日本語](README.ja.md) | 简体中文 | [한국어](README.ko.md)

Kiokuko 是面向 AI 编程智能体、与模型无关的外部记忆工具。通过一次 npm 全局安装，它会将结构化记忆保存在当前操作系统用户的 SQLite 数据库中，并通过 native stdio MCP 向 Codex、OpenCode、Claude Code 和 Hermes Agent 提供任务准备及 recall/checkpoint 工具。

## 全局安装与启用

需要Node.js 24或更高版本。

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

不带参数的 `setup` 会在 `PATH` 中检查每个受支持客户端（`codex`、`opencode`、`claude` 和 `hermes`）的可执行文件。在交互式终端中会显示选择列表，并预先勾选检测到的客户端。直接按 Enter 会接受当前选择；也可以输入以逗号分隔的客户端名称或编号来修改选择，输入 `none` 则不配置客户端。非交互终端或使用 `--json` 时不会显示提示，只配置检测到的客户端。检测到 `hermes` 时，Kiokuko 会通过 `hermes config path` 获取当前 profile；否则使用有效的 `active_profile` 标记或默认的 `$HOME/.hermes`。如果一个受支持的客户端都没有检测到，setup 仍会初始化数据库，但不会写入客户端配置。需要显式配置客户端时请使用 `--clients`；显式传入 `--clients` 时始终优先使用该选择。

npm 包名是 `@askdkc/kiokuko`，安装后的 CLI 命令名仍然是 `kiokuko`。

设置完成后，请重启 setup 结果中显示的客户端。Hermes 的 `/reload-mcp` 可以重新加载 MCP 注册，但更新后的标准技能仍需要重启或新会话才能发现；可用 `hermes mcp test kiokuko` 做 smoke test。Hermes 使用有效 profile 中的原生 stdio MCP；Kiokuko 不会创建全局指令文件、Hermes plugin 或 hook。

`setup` 是显式且幂等的操作。npm 的 `postinstall` 永远不会修改 AI 客户端配置。现有 TOML/JSON/JSONC/YAML 设置、注释、指令内容、换行符和文件权限都会保留；Kiokuko 只管理自己的区块。默认情况下，setup 还会从固定的本地清单安装 `kiokuko-ui-design-soul` 标准技能，不会在 setup 时下载或抓取 HIG 页面。

如果现有数据库存在尚未应用的迁移，setup 会先在当前用户数据目录下的 `backups/` 中创建备份并执行完整性检查。由更新版本 Kiokuko 写入的数据库会被拒绝，且不会受到修改。

```bash
# 不写入任何内容，预览确切的目标文件和计划变更
kiokuko setup --dry-run --json

# 只配置一个客户端
kiokuko setup --clients codex
kiokuko setup --clients opencode
kiokuko setup --clients claude
kiokuko setup --clients hermes

# 如果客户端进程未继承 npm 的 PATH，请使用可执行文件绝对路径
kiokuko setup --command /absolute/path/to/kiokuko

# 跳过新的标准技能放置；不会删除已安装的副本
kiokuko setup --no-standard-skills
```

Hermes 设置按 profile 隔离。像 `$HOME/.hermes/profiles/work/config.yaml` 这样的 named profile 只接收该 profile 的 MCP 配置和标准技能，root 及非活动 profile 不会被修改。另一个进程中临时使用的 `hermes -p <name>` 不会被 setup 自动推断。要明确指定 named profile，请将 profile 目录传给 `HERMES_HOME`：

```bash
HERMES_HOME="$HOME/.hermes/profiles/work" kiokuko setup --clients hermes
```

如果桌面进程无法通过 `PATH` 找到 `kiokuko`，不要传入空的 `command -v` 结果，而应迁移到绝对路径：

```bash
KIOKUKO_BIN="$(command -v kiokuko)"
test -n "$KIOKUKO_BIN" && test -x "$KIOKUKO_BIN" || { echo "kiokuko executable not found" >&2; exit 1; }
kiokuko setup --clients hermes --command "$KIOKUKO_BIN"
```

设置目标如下：

| 客户端 | MCP 配置 | 全局指令 | 运行时防护 | 标准技能 |
|---|---|---|---|---|
| Codex | `$CODEX_HOME/config.toml` 或 `~/.codex/config.toml` | `$CODEX_HOME/AGENTS.md` 或 `~/.codex/AGENTS.md` | — | `~/.agents/skills/kiokuko-ui-design-soul` |
| OpenCode | `$XDG_CONFIG_HOME/opencode/opencode.json` 或 `~/.config/opencode/opencode.json` | 同目录下的 `AGENTS.md` | `plugins/kiokuko-loop-guard.js` | 全局配置中的 `skills/kiokuko-ui-design-soul` |
| Claude Code | `$CLAUDE_CONFIG_DIR/.claude.json` 或 `~/.claude.json` | `$CLAUDE_CONFIG_DIR/CLAUDE.md` 或 `~/.claude/CLAUDE.md` | — | Claude 配置中的 `skills/kiokuko-ui-design-soul` |
| Hermes Agent | 有效 profile 的 `config.yaml`（`$HERMES_HOME`、`$HOME/.hermes` 或 `%LOCALAPPDATA%/hermes`） | 无 | 无 | 有效 profile 中的 `skills/kiokuko-ui-design-soul` |

Hermes 配置是 profile 级别的 native stdio MCP，注册 `mcp_servers.kiokuko`，其中 `command: kiokuko`、`args: [mcp]`。受管理的 canonical entry 可以通过 `--command` 只迁移 command，同时保留 args、注释和其他 server；未管理 entry、额外 field 或非 `mcp` args 仍然会产生 conflict。Hermes 内置 memory 和 skills 与 Kiokuko 分离；模型是否使用这些 MCP 工具取决于 MCP tool descriptions，属于 best effort。

如果 OpenCode 的 `opencode.jsonc` 已存在，Kiokuko 会保留注释并更新该文件。如果 Codex 中已存在不受 Kiokuko 管理的 `[mcp_servers.kiokuko]` 表，设置程序不会猜测应该覆盖哪项配置，而是直接停止。受管理的 OpenCode 防护会把可见智能体限制为 12 个 step；每个用户请求最多调用一次 `task_prepare` 和一次 `memory_checkpoint`；检查点完成后关闭工具阶段；连续三次出现相同调用或相同的只读检索结果后阻止再次执行。计数器和指纹仅保存在进程内存中。

每个标准技能文件都带有 Kiokuko 管理标记。setup 只更新固定的已知文件，完全相同时报告 `unchanged`，并保留无关的同级文件。如果同名文件没有管理标记，setup 会在任何文件或数据库写入前以 `CONFLICT` 停止。

## 记忆作用域

数据库由当前操作系统用户全局共享，但普通 recall 不会搜索整个全局数据库：

- `project` 记忆会根据 `.kiokuko.json`、已知规范路径或 Git remote 自动解析。其他项目的记忆会被排除。
- `global` 记忆仅用于真正跨项目适用的偏好和经验。
- 默认的 `auto` recall 只返回当前项目与 global 记忆。
- 没有 remote 的仓库会获得由路径派生的稳定标识。自动解析时，Kiokuko 不会向仓库写入任何文件。

MCP 接口被有意保持为最小范围：

- `task_prepare`：每个用户请求仅执行一次 Akinator 式采集、有界记忆/参考检索，并与当前客户端提供的技能和 MCP 工具完整名称及简短说明进行匹配。
- `task_answer`：仅使用用户请求或已验证仓库证据支持的答案继续采集。
- `memory_recall`：读取有界的 project/global 上下文，并始终标记为 untrusted。
- `memory_checkpoint`：在用户请求结束时仅执行一次，将有界的持久性条目保存为 `candidate` 和 `untrusted`；疑似密钥的内容会被拒绝。

这种自动使用由指令驱动，并不会拦截提示词。Codex、OpenCode、Claude Code 和 Hermes Agent 仍可能决定在某个回合不调用工具；Hermes 的自动/模型使用是基于 MCP tool descriptions 的 best effort。Hermes 内置 memory 和 skills 保持独立。Kiokuko 不会创建 Hermes 全局指令文件、plugin 或 hook，不会捕获完整对话、自动安装外部获取的技能，也不会静默地将记忆提升为 verified 状态。OpenCode 唯一安装的 plugin 是上述受限的本地循环防护；同捆标准技能是客户端原生 skill，不是 plugin。

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

对于重要工作，设置好的智能体指令会调用 `task_prepare`。该工具只询问任务类型、目标和成功条件等缺失的高价值字段，再根据查询和角色与用途标签选择本地记忆。如果客户端提供当前可用能力的完整名称和简短说明，结果还会匹配所需能力，并区分 `available`、`missing` 和 `unknown`；说明会逐项压缩或删除，该目录仅临时使用，不会存储。CLI 的 `guide` 命令可手动执行同一流程：

当任务包含 UI、UX、frontend、screen、SwiftUI、画面或 accessibility 等具体界面词汇时，`task_prepare` 会明确推荐客户端 capability 目录中的 `kiokuko-ui-design-soul`。仅有通用 `design`、backend-only 工作或纯图像生成不会触发该规则。

```bash
kiokuko guide start "Implement the API change and add tests" \
  --workspace <workspace> --json
kiokuko guide answer <session-id> --workspace <workspace> \
  --question-id target --value src/api.ts --json
kiokuko guide answer <session-id> --workspace <workspace> \
  --question-id expected --value "All tests pass" --json
kiokuko guide context <session-id> --workspace <workspace> --json
```

只有在本地检索没有相关条目，且客户端明确报告可用技能为零时，`task_prepare` 才能从以下唯一白名单公开仓库获取当前 `main` 分支树：

- https://github.com/mattpocock/skills

省略、损坏或非空的 capability 目录都会禁用该回退。手动 CLI 使用必须通过 `guide context ... --no-client-skills` 明确声明同一条件。标记为 `disable-model-invocation: true` 的技能不会被自动选择。

每个导入条目都会记录其仓库、commit SHA 和源路径。这些内容是不受信任的参考资料，永远不会自动提升为 `verified`，也不会作为命令执行。重复同步通过内容哈希保持幂等。

## 本地 Web UI

启动仅限回环地址的 HTTP 服务器，即可按角色与用途、记忆类型和跨类别标签浏览记忆条目，并在浏览器中编辑 candidate 条目：

```bash
kiokuko web
# 打开 http://127.0.0.1:4173
```

UI支持英语、日语、简体中文和韩语。首次使用时采用浏览器语言，明确选择的语言会保存在浏览器中；也可以使用`?lang=en`、`?lang=ja`、`?lang=zh-CN`或`?lang=ko`覆盖。

使用 `--port 0` 可自动选择可用端口，使用 `--json` 可将所选 URL 以 JSON 输出。Web UI 不会在非回环接口上公开服务器。verified 和 superseded 条目为只读；编辑 candidate 时会使用乐观修订检查，并保留审计记录。

`bot:researcher`、`bot:builder` 和 `bot:reviewer` 等标签可以作为跨类型筛选器。点击条目或侧边栏中的标签，会显示所有匹配条目，而不受记忆类型限制。

记忆条目是未经信任的存储数据。依赖历史条目前，请验证当前文件和运行时状态。切勿存储密码、API 密钥、令牌、私钥或会话 Cookie。

本仓库不会自动发布。执行 `npm publish`、commit 和 push 均需要用户明确授权。
