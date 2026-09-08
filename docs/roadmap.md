# dsh-acp-interactive 后续开发路线图

中文 | [English](roadmap.en.md)

本文定义 `dsh-acp-interactive` 在当前自包含 Zed 集成基础上的推荐开发顺序。ACP 负责编辑器与 agent 的通信字段和生命周期；本插件负责协议适配与 Cordis 组合；DeepSeek Harness 继续拥有模型、工具、skill、权限、持久化和 agent loop 等领域行为。

## 当前基线

版本 `1.0.1` 保留 `1.0.0` 确立的自包含 ACP v1 稳定基线，并增加
Registry terminal authentication。阶段 A、B、C 与 D1 已完成，逐 session
MCP、成功 close 的 durability boundary、并发 list/load/resume/close 隔离，
以及真实双进程 JSONL 恢复均有覆盖。阶段 E 标记为 `Deferred`。Additional
directories 仍明确不支持。

当前实现以 ACP v1 为生产协议。任何可选协议能力只在客户端声明支持且插件具备完整后端能力时公布。

Registry 发布准备增加了条件公布的 ACP terminal authentication：
支持该能力的客户端可启动独立 `--setup` 进程，配置 DeepSeek 官方 adapter
使用的 `DEEPSEEK_API_KEY`。交互由本仓库适配，凭据优先级、持久化、锁和文件权限
继续委托已发布的 Harness credentials provider；普通 ACP 进程不读取、复制或输出
密钥。设计决定见 [Registry Terminal Auth Agent Note](agent-notes/2026-08-28-registry-terminal-auth.md)。

## 能力接入边界

本仓库不实现 DeepSeek Harness 的领域能力。Web、文件搜索、LSP、终端、subagent、workflow、spill、tool-result pruning、timeout 和 loop guard 等能力的定义、执行逻辑、策略与领域事件由各自的 Harness 插件维护。本仓库只负责两类工作：一是把适合编辑器场景的已发布 Harness 插件装配进独立 launcher，并保证安装与运行时依赖闭包；二是把这些插件已经提供的请求、事件和生命周期通过 ACP 通用协议面可靠地提供给 Zed。

Additional directories 的多根目录注册、沙箱策略与跨能力强制执行由独立的 `dsh-additional-directories` DSH 插件项目负责，不在本仓库实现。本仓库在该项目形成完整、已发布的 Service Definition、Provider 与 Consumer 闭包前继续明确拒绝非空 `additionalDirectories`，也不在本路线图中承诺其交付版本。

能力按以下规则接入：

- 模型工具默认通过 Harness 工具注册表的展示元数据映射为通用 ACP `tool_call` / `tool_call_update`，不按工具名在 transport 中重新实现领域逻辑；
- 人类命令只从实际调用 `ctx.commands.register()` 的插件动态发现，模型专用工具不伪装成斜杠命令；
- 审批、结构化提问、终端增量、取消、恢复和 teardown 等涉及客户端交互或生命周期的能力，才增加相应 ACP 适配；
- spill、pruning、timeout 和 loop guard 等 Harness 内部策略不作为 ACP 能力公布，ACP 只投影其可见结果和明确错误；
- 独立 launcher 维护的是经过筛选的 editor profile，不机械复制官方完整 profile。官方 profile 对账只报告新增、移除和依赖差异，由本仓库根据发布状态、编辑器价值、可表达性和隔离要求决定是否接入，不自动改变用户行为。

## 阶段 A：对齐最新稳定 ACP v1

状态：已在 `0.6.0` 完成。实现与兼容边界见 [ACP v1 Agent Note](agent-notes/2026-08-26-acp-v1-baseline.md) 和 [Zed 兼容矩阵](compatibility.md)。

### 目标

消除旧 SDK 与最新稳定 v1 之间的协议差距，为后续功能提供稳定的类型和兼容性基线。

### 交付

- 将 `@agentclientprotocol/sdk` 升级到稳定的 1.x 版本，并处理 schema、命名与能力协商变化；
- 将 form elicitation 从 unstable 能力迁移到稳定协议；
- 支持稳定的 message ID、request cancellation、session usage/context/cost、model config category 和 boolean config option；
- 建立协议 schema conformance 测试和受支持 Zed 版本的兼容矩阵；
- 对尚未实现的稳定能力保持不公布或明确拒绝，不能通过宽松解析伪装支持。

### 验收

- 最新稳定 ACP SDK 下的类型检查、协议测试和真实 Zed 初始化通过；
- 新建、加载、恢复、取消、elicitation 和配置更新保持现有 session 隔离；
- 初始化响应只公布已经过真实组合验证的能力。

## 阶段 B：建立 Editor Profile 与 ACP 投影闭包

状态：已在 `0.7.0` 完成。评审范围和生命周期决定见 [Editor Profile Agent Note](agent-notes/2026-08-26-editor-profile.md)，机器可检查清单见 [`config/editor-profile.json`](../config/editor-profile.json)。

### 目标

为独立 launcher 定义适合 Zed/ACP 场景的 Harness editor profile，并验证所选的已发布能力能够通过通用 ACP 投影、取消和生命周期管理可靠工作。此阶段不在本仓库实现或复制 Harness 领域能力，也不以覆盖官方完整 profile 为目标。

### 交付

- 定义 editor profile 的准入规则：能力已经独立发布、不依赖 Harness checkout、适合 stdio 编辑器场景、能够安全降级，并满足 session、连接、agent、cwd 和取消隔离；
- 以官方 bundle/profile 和实际插件源码作为候选能力与依赖关系的参考，自动报告新增、移除、必要 provider 和关键 consumer 差异，但不自动复制组合或改变用户默认行为；
- 对选入的现有 Harness 能力组合完整的 Service Definition、Provider、Consumer 和 lifecycle policy；已发布包满足准入规则只代表具备候选资格，web search/fetch、增强文件搜索、LSP、持久终端、subagent 和 workflow 仍须经过显式评审和选择后才纳入；
- 模型工具统一复用 Harness `presentCall`、`presentResult` 和 `presentationMeta` 投影为 ACP 工具卡片；只有 ACP/Zed 存在稳定且有价值的专用表达时才增加特化映射；
- 仅把实际调用 `ctx.commands.register()` 的人类命令加入 ACP 目录，不维护手写命令清单，也不把纯模型工具当作斜杠命令；
- 对持久终端、subagent 和 workflow 只补充 ACP 所需的取消、settlement、迟到事件抑制和 teardown 适配；spill、tool-result pruning、timeout 与 loop guards 保持为 Harness 内部策略；
- 增加 package dependency closure、Cordis Loader、packed-install runtime closure 和 editor/official profile 差异检查。

### 验收

- 干净安装的插件可以在没有 Harness checkout 的目录中加载经评审选定的 editor profile 及其完整依赖闭包，缺少可选外部 provider 时不虚假公布能力且能明确诊断；
- 官方 profile 新增或移除候选能力、人类命令、必要 provider 或关键 consumer 时，对账检查能够报告差异，但不会未经评审改变发布组合；
- 至少通过真实 ACP 流程执行一个新纳入的人类命令和模型工具；若 editor profile 纳入 subagent、workflow 或持久终端，还必须分别覆盖其取消、settlement 和 teardown 路径；
- transport 中不出现 web、LSP、subagent、workflow、spill、pruning、timeout 或 loop guard 的领域实现，模型工具在没有专用 ACP 表达时使用通用投影；
- 多 session、多连接和多 Zed 进程之间不共享派生状态或取消信号。

## 阶段 C：Session-scoped MCP

状态：已在 `0.8.0` 完成。隔离、启动事务与 teardown 决定见 [Session-scoped MCP Agent Note](agent-notes/2026-08-27-session-scoped-mcp.md)。

### 目标

允许 Zed 向 session 提供 MCP server 配置，并将已发布的 Harness MCP client 能力适配为精确归属于该 session 的在线组合。

### 交付

- 为每个 session 建立独立的 MCP server 生命周期、工具注册和 teardown；
- 对 MCP 工具与审批执行与现有命令、skill 和工具相同的 agent scope 校验；
- 明确处理不可执行 MCP transport、启动失败、取消和恢复时的配置变化。

### 验收

- 一个 session 的 MCP 工具、配置或失败不会进入另一 session；
- load/resume 只使用当前请求携带的完整 MCP 配置，不隐式复用其他连接的运行状态；
- 连接关闭、session close 和取消会等待 MCP 调用、重连任务、工具注册与子进程完全停稳。

## 阶段 D：完整 Session 管理

状态：D1「Session 生命周期可靠性」已在 `0.8.1` 完成；阶段 D 整体仍未完成。删除、metadata 分页与 `updatedAt` 等 DSH capability 可用前不在 transport 中替代实现，ACP session fork 继续等待稳定协议与 Zed 支持。生命周期决定见 [Session Lifecycle D1 Agent Note](agent-notes/2026-08-27-session-lifecycle-d1.md)。

### 目标

补齐大规模 session 历史的发现、删除和派生索引一致性。

### 交付

- 先在 Harness persistence capability 中增加跨 backend 的删除操作，再实现 ACP `session/delete`；
- 为 `session/list` 增加稳定 opaque cursor、分页和真实 `updatedAt`；
- 协调 JSONL 真源、attachment、checkpoint 和 session-query 派生索引的删除与对账；
- 在 ACP session fork 稳定且 Zed 支持后，将 Harness 的 session fork 投影到协议；
- D1 已增加并发 list/load/resume/close、同 session 恢复互斥、close durability barrier 与真实多进程 JSONL 恢复测试；delete 并发测试随删除能力延期。

### 验收

- 删除不会由 ACP transport 直接操作 JSONL 文件或 SQLite 私有表；
- 分页过程中新增或更新 session 时，cursor 行为确定且不会重复或静默遗漏；
- close 只释放在线资源，delete 才删除持久历史，两者语义不会混合。
- D1 保证成功的 close 在返回前完成标准 session flush，另一个已启动且共享 JSONL 真源、但拥有私有派生索引的 launcher 可立即 list/load/resume；checkpoint 失败仍释放在线资源并明确失败。

## 阶段 E：丰富内容与实时 UI

状态：`Deferred`。当前核心 ACP v1 使用不依赖本阶段；仅在出现明确编辑器需求，并且对应 ACP/Zed 协议面与 Harness 领域能力形成完整闭包后重新评估。本状态不影响对现有投影缺陷进行正确性修复。

### 目标

提高 Zed 对长任务、终端工作和多媒体结果的呈现完整度。

### 交付

- 将 terminal output 从完成后一次性投影升级为增量输出，并保留不支持扩展客户端的文本回退；
- 支持音频和 embedded resource 的准入、持久化、模型模态校验与历史重放；
- 支持工具结果图片卡片以及删除文件等更完整的 diff 状态；
- 在相应 ACP 能力稳定且 Zed 支持后接入 plan operations、session compaction 和 session notices；
- 为大内容投影设置可配置上限，并复用 Harness spill 与 compaction provider。

### 验收

- 流式 terminal、图片和资源在取消或连接关闭后不会产生迟到更新；
- 不能无损持久化或重放的内容明确失败，不静默退化成不完整历史；
- 丰富内容仍遵循所选模型 route、session 日志和 attachment 所有权。

## 横向要求

每个阶段都必须保持以下约束：

- 领域逻辑留在拥有它的 Harness 插件中，ACP transport 只做协议适配、能力协商和事件投影；
- 每项能力必须具备 Service Definition、Provider 和 Consumer 的完整组合，缺少前置能力时加载失败或不公布；
- session、连接、agent、cwd、skill、MCP、审批、模型选择和取消信号保持精确隔离；
- 模型可见内容先写入 session log，再进入请求；只属于 UI 的 ACP 更新不进入模型上下文；
- 新的用户可见行为同时增加单元测试、真实 Loader/ACP 测试、取消与多 session 测试，以及适用的 Zed 兼容验证；
- 每次非平凡开发都运行本仓库测试和 `test:harness` 官方兼容套件；官方 checkout 只提供当前测试输入，不能成为安装或运行依赖；
- 包内 profile、manifest、lockfile、README、设计说明和发布文档在同一次版本更新中保持一致。

## 推荐顺序

当前主动开发顺序为 `A → B → C → D`。阶段 A 固定协议基线，阶段 B 固定 editor profile 的准入、装配和通用投影边界；二者是后续工作的前置。阶段 B 不阻塞 Harness 自身能力演进，也不要求本仓库复刻官方完整 profile。阶段 C 接入逐 session 外部工具生命周期，阶段 D 扩展持久状态；二者都必须在隔离与所有权规则稳定后实施。阶段 E 为 `Deferred`，不属于当前主动发布计划，仅在需求和前置能力成熟后恢复。Additional directories 由独立 DSH 插件项目推进，不属于本顺序。
