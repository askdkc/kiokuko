# Kiokuko（记忆库）

[English](README.md) | [日本語](README.ja.md) | 简体中文 | [한국어](README.ko.md)

**通过 MCP 连接、用 RAG 回忆，并在工作后保存记忆。**

Kiokuko 是面向 AI 编程智能体的外部记忆。

它会将过去工作中获得的知识保存到本地 SQLite，并在下一次请求中仅检索相关记忆传递给 AI。

用户无需每次都在提示词中粘贴过去的背景，也无需手动查找记忆。只需像平常一样使用 AI，项目特有的知识就会逐步积累，并在下一次工作中复用。

## 快速开始

需要 Node.js 26.1.0 或更高版本。
使用以下两条命令即可轻松开始 💕

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup` 会检测已安装的受支持客户端，并自动配置 SQLite 数据库和 MCP 连接。
交互式setup会询问是否也将已审计的community技能用作参考资料，默认选择“否”。
面向模型的记忆只能通过带 capability gate 的 MCP 工具 `task_prepare` 和
`task_answer` 进入任务。Kiokuko 不会安装在这些调用之前静默检索记忆的客户端
Hook 或插件。

设置完成后，启动目标 AI 客户端即可像平时一样使用。如果客户端已经启动，请先退出，再重新启动。

支持的客户端：

- Codex
- OpenCode
- Claude Code
- Hermes Agent

## 越用越聪明的机制

```text
用户的请求
      ↓
搜索相关的过去记忆
      ↓
AI 参考这些记忆开展工作
      ↓
保存可复用的成果或经验
      ↓
在下一次请求中再次搜索
```

Kiokuko 会重复以下流程。

1. 工作前，搜索当前项目和 Global 记忆
2. 仅将相关性高的记忆传递给 AI
3. AI 执行工作
4. 工作后，保存可复用的知识作为记忆
5. 在下一次工作中复用这些记忆

也就是说，Kiokuko 是一个**不断积累持久记忆的 RAG 系统**。

MCP 将 AI 客户端与 Kiokuko 连接起来，RAG 则检索所需记忆并传递给 AI。

## 记忆按项目分离

普通搜索不会混入无关项目的记忆。

- **Project 记忆**
  仅在当前仓库中使用的知识

- **Global 记忆**
  可在多个项目中复用的知识，例如语言、框架、数据库和工具

项目会根据 Git remote 或路径自动判断。

如果要将 Project 记忆迁移到 Global 记忆，请通过 Curator 确认候选项并明确批准。

```bash
kiokuko curator
```

## 查看记忆

通过本地 Web UI，可以搜索、查看和编辑已保存的记忆。

```bash
kiokuko web
```

请在浏览器中打开以下地址。

```text
http://127.0.0.1:4173
```

Web UI 仅在本地环境运行，不会暴露到外部网络。
Web UI 和显式 memory CLI 命令是供人类/operator使用的管理界面，不是模型绕过
`task_prepare` / `task_answer` 获取任务记忆的路径。

## 外部技能

外部技能发现仅用于参考数据，Akinator任务准备默认使用 `official` 模式。Kiokuko会
验证当前GitHub提交，将有界内容保存为不可信候选记忆，并且不会自动安装或执行。
如需关闭自动发现，请设置 `KIOKUKO_SKILL_DISCOVERY=off`；`community` 仍须明确启用。
交互式 `kiokuko setup` 会询问是否启用；批处理可使用 `--skill-discovery community`。

命令示例：

```bash
kiokuko skills find svelte --official-only --json
kiokuko skills list
kiokuko skills disable sveltejs/ai-tools/svelte-code-writer
kiokuko skills refresh sveltejs/ai-tools/svelte-code-writer
```

Web UI的外部技能页面可查看来源状态并禁用或重新启用导入映射；其中没有安装、脚本
执行或MCP注册操作。

## 安全性

Kiokuko 不会保存完整对话。

对于密码、API 密钥、令牌、私钥等看起来像机密的内容，会拒绝保存。

保存的记忆始终作为参考信息处理。当前代码、配置和执行结果优先于过去的记忆。

## 注意

Kiokuko 不是拦截提示词的机制。由于自动使用依赖于各 AI 客户端和模型对 MCP 的调用，因此不保证每一轮都会调用。

详细命令请查看以下内容。

```bash
kiokuko --help
kiokuko setup --help
```
