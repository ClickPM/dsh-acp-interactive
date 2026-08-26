# Zed 交互式 ACP 插件方案

## 目标

提供一个独立的 `dsh-acp-interactive` Cordis 插件，让 Zed 通过 Agent Client Protocol（ACP）获得接近 Codex ACP 和 Claude ACP 的交互体验。Zed 负责会话界面、流式内容、工具卡片、审批控件和计划展示；DeepSeek Harness（dsh）继续负责模型调用、agent loop、工具执行、工作目录、沙箱、权限策略和生命周期。

这不是 Codex 插件，也不是 Zed 扩展。协议适配器作为 dsh 插件运行，通过 JSON-RPC stdio 与 Zed 通信。

## 是否需要官方支持

运行不需要 Zed 为 DeepSeek 或 dsh 增加专用内置支持。只要当前 Zed 版本支持在 `agent_servers` 中启动自定义 ACP agent，就可以把 dsh 的启动命令配置进去。Zed 官方支持会影响 Registry 一键安装、非标准 `_meta` 扩展和新 ACP 功能的兼容速度，但不是第一阶段的前置条件。

DeepSeek 官方同样不需要修改 API。适配器连接的是 dsh 的 agent 和事件模型；实际模型由外围 Cordis 组合注册的 provider 选择。组合 `dsh-settings-file`、`dsh-credentials-local` 和 `dsh-llm-pi-ai` 后，ACP server 可以读取当前用户 dsh home 中与 Pi Agent 桌面版相同的 provider profile 和凭据引用，同时保留各进程与 session 的隔离。

## 包边界

- `@deepseek-ai/dsh-acp` 保持 automation-only，继续服务程序化 ACP 客户端和进程外 subagent。
- `dsh-acp-interactive` 是面向编辑器和人的独立 UI transport，不被 automation ACP 的最小协议面约束。
- 本仓库发布 `dsh-acp-interactive` launcher 与 `config/cordis.yml` 完整组合；Zed 直接启动安装后的命令，不依赖 DeepSeek Harness 源码 checkout。
- ACP 只投影 dsh 已经拥有的状态，不让 Zed 代替 dsh 执行工具或扩大文件访问范围。

自包含启动器的长期约束记录在 [Agent Note](agent-notes/2026-08-26-self-contained-launcher.md)。

## 数据流

```text
Zed Agent Panel
    | ACP JSON-RPC over stdio
    v
dsh-acp-interactive
    | create/followup/cancel + session event projection
    v
dsh agent loop -> selected provider (DeepSeek or user-configured route)
    |
    +-> dsh tools -> sandbox / subprocess / filesystem
    +-> approval/request -> ACP permission dialog -> decision returned to dsh
```

工具展示不按工具名分支。插件读取工具注册表中的 `presentCall`、`presentResult` 和持久化的 `presentationMeta`，再按 `generic`、`terminal`、`diff` 等工具自有展示意图映射到 ACP。

## 第一阶段

第一阶段交付一个可由 Zed 启动的新会话通路，并覆盖最影响编码体验的投影：

- `session/new`、`session/prompt`、`session/cancel` 和精确的单次请求结算；
- assistant 文本增量映射为 `agent_message_chunk`；
- reasoning 增量映射为 `agent_thought_chunk`；
- `tool/call` / `tool/result` 映射为带状态、位置和内容的工具卡片；
- 文件修改映射为 ACP diff，文件位置保留给 follow-along；
- 终端展示意图映射为 Zed terminal card；不支持该能力的客户端得到文本回退；
- `approval/request` 映射为 `session/request_permission`，只提供单次允许或拒绝；
- `todo/write` 映射为完整 ACP plan；
- `session/title` 映射为 `session_info_update`；
- 请求上下文与用量映射为 `usage_update`；
- `ctx.commands` 映射为 `available_commands_update`，并支持直接执行斜杠命令。

第一阶段的普通 prompt 只接受 ACP text block。图片、音频、embedded resource、额外工作目录和客户端提供的 MCP server 会被明确拒绝，不会静默丢弃。

## 第二阶段

第二阶段交付持久会话发现、恢复与关闭：

- `session/list` 从 `ctx.sessionQuery` 的 live 优先语料库返回按创建时间倒序排列的会话，支持精确 cwd 过滤与日志标题；缺少绝对 cwd 的会话不进入 ACP 结果；
- `session/load` 先校验持久会话及其 cwd，再通过 `ctx.agents.resume()` 恢复 agent，并重放已组装的用户／assistant 消息、reasoning、工具卡片、最后的 plan、标题、用量和命令目录；
- `session/resume` 恢复相同的 dsh 上下文，但不重放历史，只发送当前命令目录；
- `session/close` 取消正在执行的命令或模型轮次，等待 agent、ACP 输出队列和 continuable 后代完全停稳，再释放精确归属的 `AgentHandle`；
- 恢复历史包含 ACP 无法无损表示的丰富内容时明确失败，不会静默丢弃内容；
- 示例组合加入 JSONL persistence、checkpoint policy 和每进程内存 SQLite session query，并由真实 Loader 快照覆盖 list/load；并发编辑器 server 只共享 JSONL 真源，不共享单 owner 的派生索引。

本阶段不声明 `session/delete`。`SessionPersistence` 尚未提供跨后端删除操作；transport 直接删除 JSONL 文件或修改 SQLite 私有表会绕过持久化所有权与对账。`session/list` 目前返回完整单页且不伪造 `updatedAt`，稳定 cursor 和低成本最后活动时间由 session-query 能力提供后再接入。

## 第三阶段

第三阶段交付 ACP session config options 形式的模型与权限控制：

- `session/new`、`session/load` 和 `session/resume` 返回完整 `configOptions`，模型按 provider 分组，权限来自 `ctx.permissionPresets` 的部署配置；
- `session/set_config_option` 的模型值编码完整 provider/model route，只接受当前目录公布的值，并通过 agent-scoped model selection 在下一次 prompt assembly 生效；
- 恢复会话以最后一条 `request/header` 的 route 作为当前模型；目录不再公布该 route 时仍显示一个 current-only 选项，不会把历史选择改写成默认值；
- 权限 selector 复用 `/permission` 的唯一在线写路径，把 preset、sandbox mode 和 approval policy 一起持久化；运行中的 session 也接受切换，事件立即落账，对后续受限调用与审批请求生效；
- LLM adapter topology 变化后发送完整 `config_option_update`，直接执行 `/permission` 后也刷新 selector；
- selector 请求按 session 串行化，prompt 不会越过尚未结算的配置切换。

本阶段不增加独立 reasoning-effort selector。选择模型时采用 adapter 为该模型解析出的默认 effort。

## 第四阶段

第四阶段补齐编辑器内的协作与丰富输入：

- 组合 `ctx.planMode` 时，`session/new`、`session/load` 和 `session/resume` 返回原生 ACP `default`／`plan` modes，`session/set_mode` 委托标准 plan-mode 服务，`plan/mode` 事件发布 `current_mode_update`；
- 所选精确模型公布 reasoning efforts 时增加 `thought_level` selector，切换在下一次 prompt assembly 生效，切换模型清除显式 effort 并采用新 route 默认值，恢复会话保留最后 request header 中的精确 effort；
- baseline `resource_link` 变成持久用户消息中的明确引用；组合 attachment store 后公布 inline image 能力，图片在消息排队前校验模型 route、批量持久化并替换为 durable reference，加载历史时重新校验并投影图片字节；
- 组合 `ctx.userQuestions` 后，为本连接精确拥有的根 agent 注册稳定 ACP form elicitation provider，结构化投影普通问题、多选、自由文本和 plan-review detail，并区分用户关闭、turn 取消与 request cancellation；
- 示例组合加入 attachment store、plan mode、user-questions 与 `ask_user_question` consumer，并公布可选 vision route。

本阶段仍不接入 MCP server 与 additional directories。音频、embedded resource 和工具结果图片卡片明确失败或保持文字投影；form elicitation 只在客户端声明对应稳定 ACP capability 时启用。

## 第五阶段

第五阶段把 user-invocable skill 接入 Zed 的斜杠菜单，同时保留真实命令的直接执行语义：

- ACP 目录合并精确 agent scope 下的 `ctx.commands` 与按 session cwd 发现的 `userInvocable` skills，真实命令与 skill 同名时由命令胜出；
- `commands/change` 与 `skills/change` 分别刷新各 session 的完整目录，skill provider 返回不完整结果或失败时保留上一次完整 skill 目录，连接关闭会取消进行中的发现；
- 真实命令继续由 `commands.execute()` 直接执行；精确匹配的 user-invocable skill 作为普通用户消息进入 agent，由 `dsh-tool-skill` 完成已落账的 `agent/pre-step` 内容注入；未知斜杠名称保持 unknown command，不会进入模型；
- 每次目录查询和显式 skill 解析都携带精确 agent scope、cwd 与请求取消信号，不共享 session 间的目录或调用状态。

## 后续阶段

后续开发按协议基线、官方 Harness profile 对齐、Additional directories 与 MCP、完整 Session 管理、丰富内容与实时 UI、分发与下一代协议六个阶段推进。每个阶段的交付范围、验收条件和先后依赖见[后续开发路线图](roadmap.md)。

## Zed 连接方式

全局安装后，在 Zed 的 settings 中登记一个自定义 agent server。Windows 示例：

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "type": "custom",
      "command": "C:/Users/you/AppData/Roaming/npm/dsh-acp-interactive.cmd",
      "args": []
    }
  }
}
```

启动命令加载包内 `config/cordis.yml`，不依赖 DeepSeek Harness 源码 checkout。stdio 的 stdout 只承载 ACP 帧；诊断必须写 stderr。

## 第一阶段验收

1. Zed 能创建 session、提交文字任务并取消正在运行的任务。
2. 文字与思考在生成时分别流式出现，不等待最终消息。
3. 读文件、修改文件和 shell 命令使用工具声明的卡片、位置、diff 与终端内容展示。
4. dsh 的 ask 策略在 Zed 中出现审批控件，拒绝不会被解释成允许。
5. todo、标题、命令目录与上下文占用变化能刷新 Zed UI。
6. 多个 Zed session 之间不串流、不串审批、不互相取消。
7. 插件卸载或 stdio 断开时，所有由它创建的 agent 先停止并达到静止，再解除注册。

## 第二阶段验收

1. Zed 能发现同一 cwd 下的持久会话，并显示日志中已有的标题。
2. `session/load` 只重放组装后的消息一次，同时恢复工具卡片、计划、标题、用量与命令目录。
3. `session/resume` 恢复模型上下文但不重复发送历史。
4. `session/close` 在 prompt、斜杠命令、恢复中、连接断开及并发关闭场景下都能达到完全停稳，且不会释放其他连接拥有的 agent。
5. 无法无损投影的持久内容和不受支持的分页 cursor 明确失败。
6. 真实 Loader 组合能在新进程中列出并加载磁盘上的 JSONL 会话。

## 第三阶段验收

1. Zed 新建、加载或恢复 session 后能看到按 provider 分组的模型和当前权限 preset。
2. 模型切换只影响下一次进入 prompt assembly 的 step，运行中的 step 保持已组装 route。
3. 未公布的模型值、未知权限 preset 和未知 config id 明确失败，不改变当前选择。
4. 权限切换写入 preset、sandbox mode 和 approval policy 的标准 session 事件，运行中的 session 也允许切换，切换从后续受限调用与审批请求开始生效。
5. 多个 session 的模型选择、权限选择和串行化队列互相隔离。
6. 真实 Loader 快照覆盖新建与加载响应中的完整 config options。

## 第四阶段验收

1. Zed 新建、加载和恢复 session 后能看到 `default`／`plan` mode，切换只通过 `ctx.planMode` 生效且日志事件会刷新当前 mode。
2. 支持 reasoning effort 的模型显示 `thought_level` selector；effort 切换影响下一次 step，模型切换重置显式 effort，恢复保留已记录 effort。
3. Resource link 作为明确引用进入模型历史；inline 图片只在 attachment store 和精确 route 都支持时准入，取消不会排入迟到消息，持久历史能重放图片。
4. `ask_user_question` 与 plan review 通过 ACP form elicitation 往返选项、多选与自由文本；外部 agent、不支持 elicitation 的客户端、关闭和取消都明确失败。
5. 多个 session 的 mode、effort、图片准入和 elicitation 不串流，连接拆卸会注销 provider 并等待正在进行的准入静止。
6. 真实 Loader 快照覆盖 modes、reasoning selector、图片能力、plan 与 ask 命令目录、`session/set_mode` 更新，以及一次经 ACP form elicitation 完成的两步模型／工具往返。

## 第五阶段验收

1. 真实 filesystem provider 发现的 user-invocable skill 出现在菜单中，`/<skill-name>` 经标准 pre-step 注入完成一个模型轮次；model-only skill 不出现。
2. 同名 command/skill 由 command 胜出；未知名称明确报错，不会成为普通 prompt。
3. skill 注册、注销和 provider invalidation 会刷新对应 session 的 ACP 目录；不完整观察不清空最后一次稳定目录。
4. 显式 skill 解析可取消，两个 session 的 scoped skill 目录与调用互不影响。
