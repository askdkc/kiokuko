# 设置与故障排查

<a id="setup-messages"></a>

### npm 提示与设置错误

`install scripts not yet covered by allowScripts` 表示 npm 尚未记录这些依赖脚本的执行许可。
`esbuild` 是构建工具，`fsevents` 用于 macOS 文件监控。仅出现此提示不代表设置失败。

在产生提示的包目录中运行：

```bash
npm install-scripts ls
```

如果列出了 `esbuild` 和 `fsevents`，并且你已检查脚本、决定允许执行，可运行：

```bash
npm install-scripts approve esbuild fsevents
```

许可会写入该目录的 `package.json`。在 macOS 上全局安装 Kiokuko 时，请在错误信息显示的 Kiokuko 安装目录中操作；
在其他项目中运行这些命令，查看和修改的是那个项目的许可设置。
详情请参阅 [npm 脚本许可指南](https://docs.npmjs.com/cli/v11/commands/npm-install-scripts/)。

如果设置最终报出 `Local semantic retrieval dependencies remain unavailable` 和 `Cannot find package ... @huggingface/hub/index.js`，
说明嵌入运行时无法加载，semantic 检索尚未配置完成。尚未确认批准脚本能解决此导入错误。
寻求帮助时，请附上完整错误信息以及 `kiokuko --version`、`node --version`、`npm --version` 的输出。

### 仓库指令文件

`kiokuko use`在仓库的`AGENTS.md`（或配置的指令文件）中保留简短、稳定的引用，
生成的指令存放在`.kiokuko/AGENTS.md`。模板及仓库身份更新会刷新生成文件；
旧的带版本管理块会在下次use/setup更新时迁移为引用。请将自定义指令放在Kiokuko管理标记之外；
用户文本和其他产品的内容会保留。

常规setup会跳过缺失的根指令文件。普通`kiokuko doctor`在交互式和非TTY运行中，
都会自动创建已注册仓库缺失的根指令及生成指令文件，无需确认或额外修复标志。
前提是注册仓库ID、workspace、binding及规范路径一致。恢复只创建缺失文件，保留已有自定义内容，
无法恢复已删除的自定义指令。权限不足、不安全的符号链接和并发修改会按目标报告，
并继续处理其他目标。缺失或冲突的binding仅被诊断，不会凭猜测替换。

```bash
kiokuko doctor
kiokuko doctor --json
kiokuko doctor --fix --repair-root /absolute/path/to/project
```

`kiokuko doctor --json`只诊断，不创建缺失指令。`--fix`是显式修复已注册binding的模式；
`--repair-root`必须配合`--fix`使用。`--fix --json`仍会执行binding修复。
更新现有管理部分仍需单独的交互确认，非TTY运行不视为批准。
缺失的生成指令也可通过use/setup恢复。卸载只移除两个文件中的Kiokuko管理部分。
详见[CLI契约（英文）](cli-contract.md)。

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
详见[清理范围](cli-contract.md#uninstall)。

<a id="chatgpt"></a>

## 在 ChatGPT 中使用（预览）

通过 Developer mode 添加个人插件连接，保存和搜索记忆。目前没有商店分发版。

1. **准备 Kiokuko。** 使用 `kiokuko mcp --help` 中包含 `--profile` 和 `--access` 的版本；否则[从源码安装](chatgpt.md)。尚无数据库时运行 `kiokuko init`。
2. **安装 Tunnel 客户端。** macOS 使用[官方 Homebrew 安装方式](https://github.com/openai/tunnel-client#install-with-homebrew)：

   ```bash
   brew install openai/tools/tunnel-client
   tunnel-client --version
   ```

   其他系统参见[官方发布页](https://github.com/openai/tunnel-client/releases/latest)。在 [Tunnel 设置](https://platform.openai.com/settings/organization/tunnels)中准备关联到 ChatGPT workspace 的 Tunnel ID，以及具有 Tunnels Read + Use 权限的[运行用 API 密钥](https://platform.openai.com/settings/organization/api-keys)。

3. **在电脑上启动连接。** 将 `<tunnel_id>` 和 `<runtime_api_key>` 替换为取得的值。

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

   使用期间保持运行。在新终端中，先重新设置 API 密钥，再执行最后一行 `run` 命令。

4. **在 ChatGPT 中添加。** 开启 **Settings → Security and login → Developer mode**。在 **Plugins → ＋** 中填写名称 `Kiokuko`、说明“保存和搜索记忆”，再通过 **Connection → Tunnel** 指定同一个 ID。在新对话的工具菜单中选择 Kiokuko。[官方界面步骤](https://developers.openai.com/plugins/deploy/connect-chatgpt)

使用示例：“把这些内容保存到 Kiokuko”或“在 Kiokuko 中查找关于[主题]的记忆”。出现写入确认时，检查内容后批准。

只需搜索时，将启动命令中的 `read-write` 改为 `read`。这不会更改 ChatGPT 内置记忆的保存位置。**尚未在 ChatGPT 中实测连接。** [故障排查](chatgpt.md)

