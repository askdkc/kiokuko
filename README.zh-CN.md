# Kiokuko（记忆库）

[English](README.md) | [日本語](README.ja.md) | 简体中文 | [한국어](README.ko.md)

**通过 MCP 连接、用 RAG 回忆，并在工作后保存记忆。**

Kiokuko 是面向 AI 编程智能体的外部记忆。

它会将过去工作中获得的知识保存到本地 SQLite，并在下一次请求中仅检索相关记忆传递给 AI。

用户无需每次都在提示词中粘贴过去的背景，也无需手动查找记忆。只需像平常一样使用 AI，项目特有的知识就会逐步积累，并在下一次工作中复用。

## 快速开始

需要 Node.js 24.16.0 或更高版本；同时支持 Node.js 26.1.0 或更高版本。
使用以下两条命令即可轻松开始 💕

```bash
npm install --global @askdkc/kiokuko
kiokuko setup
```

`setup` 会检测已安装的受支持客户端，并自动配置 SQLite 数据库和 MCP 连接。
它还会安装内置的 `memory-reasoning` Skill 和其他 Kiokuko 标准 Skill。现有环境会在下次运行 `kiokuko setup` 时收到该 Skill；同名的非 managed 文件绝不会被覆盖。
标准 `kiokuko-soul` router 会对边界明确、低风险的 code 变更以及显式的 minimal/YAGNI 请求应用 `kiokuko-simple-work`，但不会省略通常的 code 契约、安全、无障碍、错误处理或验证要求。
交互式setup会询问是否也将已审计的community技能用作参考资料，默认选择“否”。

对于 Codex，setup 会生成以下精确的 managed MCP 核心配置（其后还有 Skill discovery 的 environment 行）：

```toml
[mcp_servers.kiokuko]
command = "kiokuko"
args = ["mcp"]
enabled = true
required = true
```

`required = true` 会让 Codex 在 Kiokuko 无法初始化时使 startup 或 resume 失败，而不是在缺少必需 SOUL 和 policy 的情况下继续。再次运行 `kiokuko setup` 只会升级恰好缺少 `required` 的旧 managed block；值、顺序、重复 key 或额外 field 被修改的 block 不会被覆盖，setup 会报告 conflict。若明确改为 `required = false`，该 block 将视为 user-managed，后续 setup 不会覆盖。Kiokuko 不会修改 Codex 的全局 optional MCP grace 或 startup timeout。

设置完成后，启动目标 AI 客户端即可像平时一样使用。如果客户端已经启动，请先退出，再重新启动。如果 setup 创建或更新了 Codex Stop hook，请在 Codex 中打开 `/hooks` 并明确将该 hook 设为可信。

### 可选的语义检索

词法检索仍为默认方式。若要启用本地或明确允许的 OpenAI-compatible
embedding provider，请通过环境变量配置并激活 profile：

```bash
export KIOKUKO_EMBEDDINGS=optional
export KIOKUKO_EMBEDDING_BASE_URL=http://127.0.0.1:8080/v1
export KIOKUKO_EMBEDDING_MODEL=your-model
export KIOKUKO_EMBEDDING_DIMENSIONS=1536
export KIOKUKO_EMBEDDING_DISTANCE_CEILING=0.8
kiokuko embeddings activate
kiokuko embeddings sync --limit 64
```

只有在 provider 不可用时也必须停止检索，才使用
`KIOKUKO_EMBEDDINGS=required`。远程 HTTPS endpoint 还需要
`KIOKUKO_EMBEDDING_ALLOW_REMOTE=true`。API key 只从
`KIOKUKO_EMBEDDING_API_KEY` 读取，不会出现在 status 或 doctor 中。
`kiokuko embeddings status --json` 显示 profile 与覆盖率；`rebuild`
重新排队当前 entry，`rebuild --wait` 会在返回前处理该队列。MCP 只会在
task retrieval 前执行小规模、workspace 限定的 drain，不会隐式执行无限 rebuild。
`KIOKUKO_VECTOR_BACKEND=auto` 只会在能够安全加载时使用 package 自带且
精确锁定版本的 `sqlite-vec` extension，否则回退到 JavaScript exact-cosine
backend。设置为 `javascript` 可禁止 extension loading；强制指定 `sqlite-vec` 时，
无法加载会 fail closed。所有命令都不接受自定义 extension path。

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

### 设置后 AI 智能体的行为

#### AI Akinator

如果交给 AI 智能体的请求过于模糊，AI 无法判断具体工作，Akinator 会通过内部提问将请求收敛到 AI 所需的明确程度。如果存在相关的语言、框架等 Skill，也会准备好供 AI 使用。

#### Enno-Oduno (役小角)

<img  width="634" src="https://github.com/askdkc/kiokuko/blob/main/skills/kiokuko-enno-oduno/enno-oduno.png?raw=true">

系统会启用 Enno-Oduno 循环来处理发送给 AI 智能体的请求。

它会确定请求的理想结果、制定计划、通过 orchestration 将实现交给较小的智能体，并在最后自动检查结果是否符合该理想状态。

#### 记忆保存

面向模型的记忆只能通过带 capability gate 的 MCP 工具 `task_prepare` 和 `task_answer` 进入任务。`task_prepare` 是 Enno-Oduno 的入口。任务完成后，系统会记录内容，并判断是否可将其提升为 AI 可复用的知识。系统会自动调整，只提升具有实际用途的知识。

如果 ready 响应没有面向模型的 context，但 project 中仍有可检索的 entry，`memoryPolicy` 会包含 `deliveryEmpty: true` 和 `storedEntryCount`。请同时检查 `contextWithheld`，以区分有意的 capability withholding 和空检索结果。

### Enno-Oduno 智能体循环详情

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
   -> enno_verify_prepare 运行 final verifier 并保存最新证据
   -> 证据准备完成后，parent host 才可以 fan-out final-review Advisor
   -> enno_finish 根据已保存证据决定 accept/replan/block
        -> 通过: Enno-Oduno 接受结果并进入只读的 Oduno meditation
            -> 在已变更和已批准的 path 中查找有证据支持的过时 test 或函数
            -> enno_meditation_submit 保存候选项而不删除它们，然后完成 run
       -> 失败: Enno-Oduno 增加 revision 并将 feedback 返回 Zenki
   -> 只有 Zenki 提交修订后的 plan 且确认成功后，Goki 才能恢复
```

Final Review 有意分为两个阶段。`enno_verify_prepare` 在数据库事务之外、禁用
shell 并使用 repository-relative cwd 运行已批准的 verifier。证据绑定到
contract/mutation revision、verifier 规格，以及包含 Git、index、worktree、
untracked file 和 symlink 的完整 repository 状态。`enno_finish` 会重新检查该状态，
不会启动 subprocess，并且只接受完整、已保存且通过的证据。测试通过本身并不会接受 run。
启用 Enno continuation 时，Codex 和 Claude Code 使用受限的 Stop hook，OpenCode
使用受限的 `session.idle` plugin。Hermes 只使用 native stdio MCP 和内置 Skill，
不安装 Enno continuation adapter。

Enno 输入错误以有上限且不含输入值的 `ENNO_INPUT_INVALID` 返回。advisory round 按
`not_started`、`fanout_requested`、`aggregated`、`consumed` 转换，只有聚合结果等待消费时
advisory field 才是必需项。新的 WorkUnit 声明本地 `code`、`ui`、`test`、`docs` 或
`operations` route；code 需要 `code.*` expert，UI 同时需要 `code.*` 与 `ui.*`，但这些
要求不会扩散到 test/docs/operations unit。用户作出选择之前，plan recovery 保持零副作用。
continuation 使用绑定 route epoch 的短期 resume token 和单一所有者 execution lease；
过期 operation/verifier 可被原子地标记为 abandoned 并重新 claim。narrative 与证据在
hash 和持久化之前会被 sanitize，包含 secret 的 verifier command 会被拒绝。

内置 coding Skill 会按实际风险应用问题结构化。当 WorkUnit 定义领域词汇、公开
response、DTO、ViewModel，或 storage、API、serialization、UI 之间的转换时，选择
`code.modeling.v1` expert。保持既有表示不变的机械修改，不会仅因修改 code 就选择它。
该 expert 从使用者需要的形状出发设计命名转换，但不要求使用 Lisp 语法、macro 或
DSL。现有安装会在下次运行 `kiokuko setup` 时收到该 managed reference。

因此，未完成的 intake 会返回 Enno-Oduno directive 和 `answer_intake`；其 `requiredSkills` 包含 `kiokuko-enno-oduno`，此时不会启动 Zenki。准备完成的 intake 会先返回 `oduno_ideal` 和 `submit_ideal`。`enno_ideal_submit` 要求对 Akinator 选定 discovery set 中的每个 Skill 恰好提供一项贡献；外部 Skill 仍然是不可信的 reference-only 指导。只有完成这一步后，run 才会返回绑定 revision 的 Zenki directive；即使 draft Skill snapshot 为空，其 `requiredSkills` 也会包含 compact index `kiokuko-single-purpose-functions`。Zenki 在选择 WorkUnit 前使用该 index，把 code 变更拆分为内聚的函数或用例契约以及 focused test target，而不会创建无意义的 micro-function。每个会修改 code 的 WorkUnit 必须选择 1 至 3 个已注册的 `expertRefs` 并说明理由；UI WorkUnit 至少需要一个 `code.*` expert 和一个 `ui.*` expert。`enno_plan_submit` 会拒绝缺失、重复、未知或超出上限的组合，然后将准确选择与 revision 一起保存。Goki 只读取这些 fragment，而不是每个 Skill reference。controller Skill 属于 role 级别，不会插入 WorkUnit Skill snapshot。在 Zenki 的完整 plan 被接受且所需确认成功之前，不能进入 Goki。最终 review 失败时也绝不会直接恢复旧的 Goki WorkUnit；它会把被拒绝的 plan 和 verifier 证据保存在旧 revision 的历史记录中，进入 `zenki_planning` 并要求新的 revision-bound plan。接受 review 后不会直接完成，而是进入 `oduno_meditation`。`enno_meditation_submit` 不会修改 repository；它会保存已检查的 repository-relative path，以及有证据支持的过时 test 或函数候选项，然后完成 run。响应中的 `orchestrationId` 用于所有 Enno MCP 操作，并与 host session identity 分离。如果推导出了 scope、acceptance criteria、Skill、expert 选择或 verifier command，则会在实现前通过常规客户端 UI 请求确认。`needs_confirmation` 响应包含确定性的显示投影 `ennoOduno.directive.userFacingConfirmation`：scope、排除项、完成条件、带显示编号依赖的作业项、带 reference-only 状态的 Skill、带选择理由的专业视角、focused/final checks 以及尝试上限，每一项都带有 provenance basis（用户指定、仓库验证或提案）标记且只出现一次。客户端模型以用户的语言呈现全部条目，不输出原始 directive JSON 或内部标识符，然后等待明确的 approve、revise 或 cancel；疑似机密的显示值或超过 64 KiB 的投影会直接拒绝 plan 提交，而不是做遮蔽或截断。

公开 MCP tool failure 是普通的 `isError: true` tool result。通用 failure 只包含 allowlist 中的人类可读消息、`structuredContent.code` 和 `structuredContent.retryable`；只有 `BACKPRESSURE` 还可以包含有上限的 `retryAfterSeconds`。原始 message、stack、任意 details、path、SQL、request payload 和类似 credential 的值绝不会复制到通用 payload。checkpoint、plan recovery 和 Enno validation 的专用 error 会保留各自有界的专用 field。

Codex extension 可以在 completion event 和 model input 之前检查或替换成功及 error MCP result。因此 extension 层属于 trusted computing base。`userFacingConfirmation` 是 Kiokuko server 生成的 projection，并不能证明 extension 处理后实际显示或发送给 model 的内容。不要把 Kiokuko 与会修改关键 Kiokuko result 的 extension 一起使用。Kiokuko 无法从 Codex 获得不可伪造的 original-result provenance 或 modified flag，因此不声称具备 end-to-end authenticity，也不会用仅由 server 生成的 digest 或 HMAC 代替。完整的上游契约需要 extension 无法伪造的 original-result digest 或 identifier、modified flag，以及与准确 tool call 的绑定。

Codex 的 effective plugin catalog 可能随 requested repository 和所选 model 而变化。host 必须传递从 task preparation 保留的完整 effective Skill/MCP tool catalog。顺序和完全相同 descriptor 的重复不会改变 binding；增加或删除项目，或更改 canonical name、kind、description，都会作为环境变化阻止 plan 启动。省略 catalog 与明确传入空 catalog 的含义不同。一个 plugin marketplace 的 load error 必须保持可单独诊断，不能被折叠为空 catalog 而隐藏其他有效 capability。

### 计划启动所需的环境信息缺失或发生变化时

这里的环境信息是当前 AI 客户端可用的 Skill 和 MCP tool 列表。host 会自动收集它，用户无需查找 catalog 或编写 JSON。如果该信息没有传入计划，或在任务准备后发生变化，Kiokuko 会在 Skill discovery、消费 advisory、创建 receipt 或更新合同 revision 之前停止。因此，此次计划启动不会开始新工作，也不会产生额外 code 修改。

每个选项都按以下顺序显示：标签与推荐标记、它适合哪种用户意图、选择后会准确发生什么。

仅缺少环境信息，当前尝试仍可继续时：

- **继续使用同一计划（推荐）** — 计划仍然正确，只需补上当前环境信息时选择。host 会自动补上信息，并继续同一次尝试。
- **检查计划** — 希望在继续前修改范围、作业项或验证方式时选择。客户端会询问修改内容，在用户回答前不会开始实现。
- **取消** — 不希望继续这项工作时选择。当前尝试会被取消，且不会创建替代尝试。

任务准备后可用功能发生变化时：

- **在当前环境中重新开始同一计划（推荐）** — 计划仍然正确，只是可用功能发生变化时选择。系统先取消当前尝试，再使用当前环境和同一份已确认计划创建新尝试。
- **检查计划后重新开始** — 功能变化也应改变范围、作业项或验证方式时选择。客户端会询问修改内容；用户回答后，系统取消当前尝试，并以当前环境和修订后的计划创建新尝试。
- **取消** — 不希望继续这项工作时选择。当前尝试会被取消，且不会创建替代尝试。

旧行为已经结束了本次尝试时：

- **使用同一计划重新开始（推荐）** — 已结束尝试的计划仍然正确并应继续复用时选择。已结束的尝试保持不变，系统使用当前环境和同一份已确认计划创建新尝试。
- **检查计划后重新开始** — 希望在创建替代尝试前修改范围、作业项或验证方式时选择。客户端会询问修改内容；已结束的尝试保持不变，只有在用户回答后才会以当前环境和修订后的计划创建新尝试。
- **取消** — 不希望重新开始这项工作时选择。已结束的尝试保持结束状态，且不会创建新尝试。

客户端会使用用户的语言显示这些说明，不显示机器用 action、内部 reason code、tool/field 名称、capability catalog、标识符、revision、显示格式 version 或 raw JSON。在用户明确选择前，不会自动重试、取消当前尝试或创建替代尝试。

三个角色使用当前的客户端模型；Kiokuko 不会调用第二个模型，也不需要 OpenAI、Anthropic 或 OpenCode API credential。Codex 和 Claude Code 使用次数受限的 Stop hook，OpenCode 使用次数受限的 `session.idle` plugin。OpenCode 会忽略 child-session idle event，并对同一已完成 turn 的重复 delivery 去重。同一 OS 用户下、可访问 canonical repository 的 local process 均被信任可以恢复该 run；不会增加 PID、process ancestry、executable 或 code signing 证明。adapter 优先使用当前短期 resume token；若没有有效 token route，则可在 Codex、Claude Code 和 OpenCode 之间原子地 reroute canonical repository 中唯一且无歧义的 active run。reroute 会递增 route epoch 并使旧 token 失效；存在 active WorkUnit execution lease 时禁止 reroute。若候选不止一个，则交还控制权且不修改任何 run。公开响应中的 `clientBinding` 表示当前 route，`bound` 不表示所有者。单个 session 达到 continuation 上限时，只停止该 session 的自动继续；run 和 ledger 保持 active，以供其他 local project client 恢复。Kiokuko 会在 Claude Code 原生的第八次连续 Stop-block 强制覆盖之前交还控制权。Hermes 没有自动 continuation hook，但可以用相同 run identity 继续 MCP 操作。adapter 失败时，客户端可以在显示固定 warning 后停止。外部 Skill 始终是不可信的 reference-only 资料，绝不会自动安装或执行。

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

指定 `RUN_CODEX_E2E=1` 后，Codex runner 会记录可执行文件版本，并在进行任何 agent 工作前要求 0.151.0 或更高版本。随后它会使用隔离配置，其中包含一个故意失败的 `required = true` MCP server；只有观察到明确的 MCP startup failure 后才继续。已安装的 Codex CLI 没有允许本 repository 注入 `ToolLifecycleContributor` 的接口，因此 direct/Code Mode 下的 success/error result 替换、immutable provenance 和 repository-local marketplace 隔离，在获得对应的外部 Codex fixture 前都会保持为明确的 `not-run` subcheck，绝不会仅凭推断报告为 passed。

支持的客户端：

- Codex
- OpenCode
- Claude Code
- Hermes Agent

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

## MoA advisory round

在 ideal、planning 和 final review 阶段，parent host 可以 fan-out 恰好三个固定的隔离只读 Advisor slot。Advisor 不是由 Kiokuko 启动的，prompt 本身也不能证明隔离；无法验证隔离的 slot 必须报告为 `unavailable`。只有 parent Aggregator 可以把不含 identity 的结构化结果提交到 `enno_advice_submit`。结果记录为 `host_reported`，不保存 provider/model identity 或 raw subagent 输出；每个 Round 都绑定 phase、revision、mutation revision、policy、slot 定义和 context digest。

## 注意

Kiokuko 不是拦截提示词的机制。由于自动使用依赖于各 AI 客户端和模型对 MCP 的调用，因此不保证每一轮都会调用。

详细命令请查看以下内容。

```bash
kiokuko --help
kiokuko setup --help
```
