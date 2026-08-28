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
对于新安装的 Codex、Claude Code 和 OpenCode，setup 还会启用 Enno-Oduno 智能体循环。现有的受管理环境在明确选择 `--enno-oduno on` 之前保持不变；`--enno-oduno off` 只会删除 Enno-Oduno 所有的 hook 或 plugin。
setup 会将内置的 `kiokuko-enno-oduno` controller Skill 与 `kiokuko-single-purpose-functions`、`kiokuko-ui-design-soul` 一起安装到每个选中的受支持客户端。
面向模型的记忆只能通过带 capability gate 的 MCP 工具 `task_prepare` 和
`task_answer` 进入任务。`task_prepare` 也是 Enno-Oduno 的入口：Enno-Oduno 会识别调用方 harness、负责 Akinator intake，并在把可执行请求交给 Zenki 之前推导 Oduno 理想态。hook 不会静默检索记忆或绕过规划；它们只会把 canonical repository 中唯一且无歧义的 pending active run 绑定到 client session，然后 gate Oduno、Zenki、Goki 或最终 review 的继续执行。它们绝不会选择 repository 范围内的最新 run。

每次调用 `task_prepare` 前，客户端模型都必须为当前逻辑请求完整读取本地 `kiokuko-soul` Skill，并传入 `soulRead: true`。所有任务还必须提供完全匹配的本地 `kiokuko-soul` capability；即使 intake 尚未完成，缺失或 availability 未知也会 fail-close。这个 boolean 是客户端的明确 attestation，并不是模型已经理解并遵循该 Skill 的 remote proof。

设置完成后，启动目标 AI 客户端即可像平时一样使用。如果客户端已经启动，请先退出，再重新启动。如果 setup 创建或更新了 Codex Stop hook，请在 Codex 中打开 `/hooks` 并明确将该 hook 设为可信。

### Enno-Oduno 智能体循环

对于 `build`、`debug`、`review` 和 `devops` 任务，`task_prepare` 会启动 run-bound loop 并返回 `ennoOduno`。强制执行的角色顺序如下：

```text
用户请求
  -> task_prepare: Enno-Oduno 识别 Codex、Claude Code 或 OpenCode
  -> 当 currentRole 为 Enno-Oduno 时，读取并应用 requiredSkills 中的 kiokuko-enno-oduno
  -> Enno-Oduno 将必要的 Akinator 问题返回给用户
  -> Oduno 理想态根据 task_prepare handoff 和 Akinator 发现的每个 Skill 推导最优目标
  -> enno_ideal_submit 保存理想态，只有此后才把它交给对应 harness 的 Zenki
  -> Zenki 首先读取并应用 requiredSkills 中的 kiokuko-single-purpose-functions
  -> 将 code 变更拆分为单一内聚的函数/用例契约、职责、变更理由和 focused test target
  -> Zenki 为每个 WorkUnit 选择 1 至 3 个带版本的 expertRefs，默认不读取未选择的 fragment
  -> Zenki 提交 WorkPlan、WorkUnit、expert refs、Skill snapshot 和 verifier
  -> Enno-Oduno 获取所需的用户确认
  -> Goki 只 orchestration 已批准的 WorkUnit
  -> Enno-Oduno review 最新的 final-verifier 证据
       -> 通过: Enno-Oduno 接受结果并进入只读的 Oduno meditation
            -> 在已变更和已批准的 path 中查找有证据支持的过时 test 或函数
            -> enno_meditation_submit 保存候选项而不删除它们，然后完成 run
       -> 失败: Enno-Oduno 增加 revision 并将 feedback 返回 Zenki
  -> 只有 Zenki 提交修订后的 plan 且确认成功后，Goki 才能恢复
```

因此，未完成的 intake 会返回 Enno-Oduno directive 和 `answer_intake`；其 `requiredSkills` 包含 `kiokuko-enno-oduno`，此时不会启动 Zenki。准备完成的 intake 会先返回 `oduno_ideal` 和 `submit_ideal`。`enno_ideal_submit` 要求对 Akinator 选定 discovery set 中的每个 Skill 恰好提供一项贡献；外部 Skill 仍然是不可信的 reference-only 指导。只有完成这一步后，run 才会返回绑定 revision 的 Zenki directive；即使 draft Skill snapshot 为空，其 `requiredSkills` 也会包含 compact index `kiokuko-single-purpose-functions`。Zenki 在选择 WorkUnit 前使用该 index，把 code 变更拆分为内聚的函数或用例契约以及 focused test target，而不会创建无意义的 micro-function。每个会修改 code 的 WorkUnit 必须选择 1 至 3 个已注册的 `expertRefs` 并说明理由；UI WorkUnit 至少需要一个 `code.*` expert 和一个 `ui.*` expert。`enno_plan_submit` 会拒绝缺失、重复、未知或超出上限的组合，然后将准确选择与 revision 一起保存。Goki 只读取这些 fragment，而不是每个 Skill reference。controller Skill 属于 role 级别，不会插入 WorkUnit Skill snapshot。在 Zenki 的完整 plan 被接受且所需确认成功之前，不能进入 Goki。最终 review 失败时也绝不会直接恢复旧的 Goki WorkUnit；它会把被拒绝的 plan 和 verifier 证据保存在旧 revision 的历史记录中，进入 `zenki_planning` 并要求新的 revision-bound plan。接受 review 后不会直接完成，而是进入 `oduno_meditation`。`enno_meditation_submit` 不会修改 repository；它会保存已检查的 repository-relative path，以及有证据支持的过时 test 或函数候选项，然后完成 run。响应中的 `orchestrationId` 用于所有 Enno MCP 操作，并与 host session identity 分离。如果推导出了 scope、acceptance criteria、Skill、expert 选择或 verifier command，则会在实现前通过常规客户端 UI 请求确认。

三个角色使用当前的客户端模型；Kiokuko 不会调用第二个模型，也不需要 OpenAI、Anthropic 或 OpenCode API credential。Codex 和 Claude Code 使用次数受限的 Stop hook，OpenCode 使用次数受限的 `session.idle` plugin。OpenCode 会忽略 child-session idle event，并对同一已完成 turn 的重复 delivery 去重。如果 `task_prepare` 时 host session 不可用，第一个匹配的 hook 只会在恰好有一个 pending active run 匹配时以原子方式绑定；如有歧义则不作猜测并交还控制权。已完成的 binding 不可更改。Kiokuko 会在 Claude Code 原生的第八次连续 Stop-block 强制覆盖之前交还控制权。adapter 失败时，客户端可以在显示固定 warning 后停止。外部 Skill 始终是不可信的 reference-only 资料，绝不会自动安装或执行。

```bash
kiokuko setup --clients codex,opencode,claude --enno-oduno on
kiokuko enno run --role zenki --input-json -
```

真实客户端测试是可选的，并与 release gate 分离。缺少相应环境变量时会报告 `not-run`：

```bash
npm run test:e2e:codex
npm run test:e2e:opencode
npm run test:e2e:claude
npm run test:e2e:agents
```

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
