# 行为参考

[dsh-acp-interactive](../README.zh.md) 所实现 ACP 能力面的完整行为：插件契约、认证、各方法语义、session 配置、工具执行，以及各能力面对模型的成本。English: [reference.en.md](reference.en.md).

## 插件

`apply(ctx, config)` 需要 `agents`、`commands`、`llm`、`skills`、`tools`、`sessions`、`sessionPersistence` 和 `sessionQuery`。它只回答自己创建的 agent 的审批请求，并把外来请求交给下一个监听器。一条连接可以拥有多个互相隔离的 session；每个事件、选择、skill 查找和审批在进入 wire 前都会核对精确的 agent 对象。组合 `permissionPresets` 服务后会增加权限 selector；缺少该服务时模型选择仍然可用，而权限配置会省略。

| 配置 | 含义 |
|---|---|
| `provider` | 新建 agent 使用的可选 provider route。 |
| `model` | 新建 agent 使用的可选模型 id。 |

`stream` 只是运行时测试覆盖项。生产环境的 stdout 仅承载 ACP 帧，输入帧来自 stdin。
## 认证与凭据

首次使用 DeepSeek 官方 API 前，可在终端运行：

```sh
dsh-acp-interactive --setup
```

该交互不会回显输入的 API key，并通过 Harness credentials 服务把
`DEEPSEEK_API_KEY` 原子写入 `$DSH_HOME/.credentials.yaml`；Provider
负责文件锁、并发更新及 POSIX 下的 `0700` 目录／`0600` 文件权限。已有
file credential 时留空会保留原值；若启动环境已经提供
`DEEPSEEK_API_KEY`，环境值按 Harness 优先级生效，命令不会写入一个被遮蔽的
file credential。此流程只保存凭据，不会发送网络请求；第一次模型请求仍负责
验证 key 是否有效。

`initialize` 始终公布一个 `deepseek-api-key` 认证方法。声明 ACP terminal
authentication 的客户端（稳定的 `clientCapabilities.auth.terminal` 或旧的
`_meta["terminal-auth"]` 标志）收到的是 `terminal` 类型方法，会用同一个
`--setup` 流程打开交互式终端；对于稳定版只认方法上旧 `_meta["terminal-auth"]`
对象的 Zed，该方法同时携带这个对象，指向运行本服务的 Node 可执行文件和本包的
`bin.js`；不声明该能力的客户端收到的是普通 agent 类型方法，
其描述指向 `dsh-acp-interactive --setup` 和 `DEEPSEEK_API_KEY`，`authenticate`
随即成功返回——凭据由 Harness 凭据存储在第一次模型请求时解析，不由 transport
处理。terminal setup 是独立进程，不会启动 ACP transport；正常服务模式仍保留
stdout 仅传输 JSON-RPC 的约束。

当组合的默认 route 是 DeepSeek 官方 provider 且 `DEEPSEEK_API_KEY` 尚未配置时，
`session/new` 返回 ACP 的 `auth_required` 错误，因此 Zed 等客户端会在第一次
提问前展示该认证方法，而不是在第一次模型请求时才报错。该检查只读取凭据的
"已配置"状态，不读取值；`--setup` 存入的 key 会被下一次 `session/new`
直接看到，无需重启。选择其他默认 provider 的部署不做此门控；模型目录中还有
其他 provider（例如 `settings.yaml` 里的 `llm-pi-ai` 路由）时也不做——这样的
用户可能持有那些路由的凭据并切换过去。但当前 route 为 DeepSeek 官方 provider
的 `session/prompt` 无论如何都会做同样的检查，因此缺少 DeepSeek key 表现为
`auth_required`（客户端随即展示认证操作），而不是模型调用错误；直接的斜杠命令
不做门控。
## 协议

插件实现 `initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/list`、`session/load`、`session/resume` 和 `session/close`。文本与 reasoning 增量会立即流式发送。工具调用读取每个工具的 `presentCall`、`presentResult` 和持久化的 `presentationMeta`；`generic`、`diff` 和 `terminal` 意图无需按工具名分支即可映射为 ACP 卡片。Editor profile 新增的 `glob`／`grep` 由 Harness 的已发布 filesystem-search 插件和随包 ripgrep 执行，仍走相同通用投影。通过 `subagent` 或 `subagent_fork` 工具发起的委托也是同类卡片：子 agent 的事件折叠为卡片内有界的 transcript，父 agent 的工具结果结算卡片。`todo/write`、`session/title`、请求容量、provider 用量以及命令注册表变化会更新对应的客户端 session。

新会话收到第一条合格的文字提示后，会先发布 Harness 的即时确定性回退标题，再异步使用该次主请求已记录的精确 provider/model route 概括标题。模型结果作为新的 `session/title` 事件持久化并通过 `session_info_update` 替换客户端标题；生成失败、超时或输入超过 4096 字节时保留回退标题，不影响主 agent 响应。后续提示不会自动反复改名。

`session/list` 从 live 优先的查询语料库读取 session，按确定性的创建时间倒序返回，省略没有已记录绝对 cwd 的 session，支持精确 cwd 过滤，并尽可能附带日志中的标题。当前响应为不分页的完整结果；非 null cursor 会明确失败。

`session/load` 恢复持久化 dsh agent，并在返回前重放已组装的人类与 assistant 消息、reasoning、图片、工具卡片、最新计划与标题、最终用量以及命令目录。它不会重放原始 assistant chunk，因此组装后的消息只出现一次。`session/resume` 恢复相同上下文但不发送历史。`session/close` 取消进行中的 prompt 准入、skill 发现、模型或命令工作，等待输出与 continuable 后代静止，通过标准 `ctx.sessions.flush()` durability barrier 后再释放精确归属的 agent；成功返回后，另一个共享 JSONL 真源的进程可以立即发现并恢复历史。Checkpoint 失败仍会释放在线资源并明确报错，close 不删除持久历史。

MCP 配置是在线、完整且逐 session 归属的。Stdio command 直接以 executable 加 argv 传递，不经过 shell 拼接；显式 env 和 HTTP headers 不会持久化到 session log，也不会进入模型上下文。支持稳定 ACP v1 的 stdio 与 HTTP transport；SSE、ACP 代理 MCP 和未知变体会明确失败。初始连接或工具发现失败会使整个创建／恢复事务失败，并回滚此前已经启动的全部 server。Load/resume 只采用当前请求的完整配置，因此省略、移除、更换或启动失败的 server 都不会继承旧连接。确定性的 `mcp__<server>__<tool>` 名称在恢复后保持稳定，同时逐 session 私有 Cordis root 允许两个 session 使用同名 server 而不共享工具。

个人统一配置可放在客户端侧，但不是本包的运行依赖。例如 Zed 的 `context_servers` 可把每个服务配置为 `agent-config-mcp serve <service-id>`，随后通过标准 ACP `mcpServers` 传入本包；本包仍只消费协议记录，不读取个人目录或识别该命令。独立 Harness WebUI 若使用自己的 agent-config consumer，必须在每个 agent 的私有 Cordis root 中另建连接，而且不能把该 consumer 加入本包的 `config/cordis.yml`。因此 Zed ACP 与 `npx dsh` WebUI 可以共享静态服务定义和凭据引用，但不共享 MCP Client、transport、工具注册表、session ID、取消信号、子进程或重连任务。完整边界见 [Agent Note](agent-notes/2026-09-07-agent-config-integration.md)。

ACP 命令目录会合并精确 agent 的 `ctx.commands` 视图，以及按其 cwd 与 scope 发现的 `userInvocable` skill。真实命令与同名 skill 冲突时由命令胜出。`commands/change` 和 `skills/change` 会触发按 session 的完整替换更新；skill 观察不完整或失败时保留上一次完整条目，完整空结果会删除旧条目。以 `/<skill-name>` 开头的输入若仍能解析为用户可调用定义，就进入普通用户消息路径，由 `@deepseek-ai/dsh-tool-skill` 完成标准、已落账的 `agent/pre-step` 注入。未知斜杠名称仍是未知命令；仅限模型的 skill 既不公布，也不接受为 ACP 显式 skill 调用。

命令目录本身不声明领域命令；包内 editor profile 挂载 `/permission`、`/plan`、`/compact`、`/goal` 和 `/feedback` 及其对应 domain/provider，目录仍只从实际的 `ctx.commands.register()` 动态发现。该 bridge 只执行已注册的 command，不把模型工具误当作斜杠命令。

当前支持文字、resource link 和内联光栅图片 prompt。Resource link 会成为持久用户消息中明确的方括号引用。组合 attachment store 后，初始化会声明图片输入；每张图片都会针对所选模型 route 完成校验和持久化后才排入消息，因此 session 日志只保存 durable reference。重放时，图片会经校验后成为内联 ACP 内容。音频、embedded resource 和 additional directory 会被明确拒绝；Additional directories 的领域能力由独立的 `dsh-additional-directories` DSH 插件项目负责。直接斜杠命令仍只接受文字。

组合 `ctx.planMode` 后，新建、加载和恢复的 session 会公布 `default` 与 `plan` mode。`session/set_mode` 委托该服务处理，已提交的 `plan/mode` 事件发布 `current_mode_update`；transport 不保留平行的 mode 状态。

组合 `ctx.userQuestions` 后，插件会为自己精确拥有的根 agent 注册 provider。声明稳定 ACP form elicitation 的客户端会收到结构化问题、选项、多选字段、可选自由文本和 plan-review 详情。拒绝或关闭返回 `ASK_CANCELLED`，turn 或 request 取消返回 `ASK_ABORTED`，未知的未来 action 会失败关闭；不支持 form elicitation 的客户端会明确失败。

## Session 配置

`session/new`、`session/load` 和 `session/resume` 返回完整的 ACP `configOptions` 列表。模型 selector 按 provider 对各 adapter 的建议目录分组，每个值编码完整的 provider/model route。所选 route 在下一次 prompt assembly 边界生效；已经进入 assembly 或正在运行的 step 保留已捕获 route。恢复的 session 使用最后一条已记录 request header；若目录不再公布该 route，它仍作为 current-only 行显示，不会被组合默认值替换。客户端提交不在当前目录中的值会被拒绝。

配置投影接受 ACP 1.x 的 `model_config` category，并按客户端 `session.configOptions.boolean` 能力协商 boolean option。当前组合没有真实 boolean 领域配置，因此不会制造或公布开关；未知 boolean 配置与错误值类型均明确拒绝。

当所选模型公布 reasoning effort 时，`thought_level` selector 会暴露 `Default` 和每个 adapter 自有 effort。所选值在下一次 prompt assembly 边界生效。切换模型会把显式 effort 重置为新 route 的默认值；恢复 session 时从最后一条 request header 恢复 effort，在对应目录行或全部 reasoning metadata 不可用时仍显示 current-only 历史值。

组合 `ctx.permissionPresets` 后，权限 selector 会暴露其配置的 presets。切换复用现有 `/permission` 写路径，因此 preset、sandbox mode、approval policy、在线 approval 状态和持久事件保持一致。运行中的 session 也接受权限变更：切换立即写入持久事件，对后续受限调用与审批请求生效。配置请求按 session 串行化，prompt 不能越过尚未结算的切换。Adapter topology 变化、selector 切换和直接执行 `/permission` 都会发布完整 `config_option_update`。

## 工具执行与权限

ACP 不执行 dsh 工具。工具调用始终留在 harness 内，继续使用原有 cwd、沙箱、子进程、超时和生命周期策略。由本 bridge 创建的 `approval/request` 会成为带 `allow_once` 和 `reject_once` 的 ACP permission request；取消仍是取消，未知选项不会获得授权。

Zed terminal 扩展按能力启用。客户端声明 `_meta.terminal_output` 后，terminal 展示意图会产生终端元数据和已捕获输出；其他客户端得到 fenced console 回退。location 和 diff 中的文件路径保持不变，因此 editor follow-along 打开的是工具实际操作的文件。

## 模型体验

### Prompt 与命令

#### 模型看到什么

普通 ACP 文字 prompt 会成为一条 human `user/message`，进入标准 dsh 请求。以斜杠开头的 prompt 会先解析真实 `ctx.commands` 条目；否则，精确匹配的用户可调用 skill 仍作为用户消息，并获得标准的已落账 skill 注入。命令发现和直接输出不进入模型历史，但命令所拥有的领域变更可能影响后续请求。

#### Token 影响

普通 prompt 文字与其他 dsh human message 具有相同的留存 token 成本。直接命令的发现、输入和输出不增加模型 token；用户显式 skill 通过标准 skill consumer 加入其渲染后的指令，命令所拥有的领域决定后续任何模型可见投影的成本。

#### KV Cache 影响

普通 prompt 文字追加在可复用请求前缀之后。直接命令流量不影响 cache；skill 注入会改变该请求追加的上下文，命令所拥有的模型可见变化遵循该领域的 cache 行为。

### UI 投影

#### 模型看到什么

消息、思考、工具卡片、审批、计划、标题、用量和命令更新只属于客户端。它们不增加 token，也不改变 KV cache 复用。工具结果和人工权限决定只通过普通 dsh tool-result 路径影响模型。

Subagent 卡片同样只属于客户端。折叠进父卡片的子 agent transcript 不进入任何一方模型的上下文；父 agent 只通过普通 tool-result 路径看到子 agent 的最终输出，子 agent 只看到委托的 prompt 以及 Harness 为委托运行追加的标准运行时上下文。

#### Token 影响

ACP 更新不增加模型 token。工具结果保留普通 dsh 模型可见成本。一次委托由子 agent 在继承或配置的 route 上发起自己的请求；父 agent 只为该工具调用和子 agent 的最终输出付出 token。

模型生成标题使用独立的辅助请求。它只读取首条合格用户消息，最多输出 32 token，并产生所选 route 的普通用量；生成的标题及其输入封装都不会进入主 agent 历史。

#### KV Cache 影响

UI 投影不影响复用。工具结果通过标准 session surface 追加，并产生该路径通常具有的 cache 影响。

### 模型、reasoning、mode 与权限控件

#### 模型看到什么

Selector 与 mode 元数据仅属于客户端。模型和 reasoning 选择会改变下一次已组装请求所记录的 route 字段。Plan mode 通过 `ctx.planMode` 改变标准 plan 指引与退出工具行为。权限选择会改变后续工具执行，以及 sandbox 和 approval 插件拥有的标准权限说明。

#### Token 影响

这些控件本身不增加模型 token。所选 route 和 effort 遵循该模型通常的 token 行为；plan mode 会加入配置的指引；权限 preset 只产生其既有 policy 投影的 token 影响。

#### KV Cache 影响

改变 provider 或模型后，下一次请求开始使用该 route 的 cache identity。改变 reasoning effort 或 plan 指引会改变请求及其可复用前缀。权限选择遵循既有 sandbox/approval 投影行为，不会把 ACP 流量加入 prompt。
