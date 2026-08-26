# dsh-acp-interactive 后续开发路线图

中文 | [English](roadmap.en.md)

本文定义 `dsh-acp-interactive` 在当前自包含 Zed 集成基础上的推荐开发顺序。ACP 负责编辑器与 agent 的通信字段和生命周期；本插件负责协议适配与 Cordis 组合；DeepSeek Harness 继续拥有模型、工具、skill、权限、持久化和 agent loop 等领域行为。

## 当前基线

版本 `0.6.0` 提供独立的 `dsh-acp-interactive` 启动命令、包内 Cordis profile 和按平台互斥的原生 shell，并以 `@agentclientprotocol/sdk 1.4.0` 作为稳定 ACP v1 基线。用户无需下载或修改 DeepSeek Harness 源码，即可在 Zed 中使用文本与 reasoning 流、工具卡片、diff、审批、计划、模型与 reasoning effort 选择、权限 preset、图片、resource link、结构化提问、持久 session、官方人类斜杠命令以及 user-invocable skill。

当前实现以 ACP v1 为生产协议。ACP v2 仍属于 Draft，不作为近期功能的默认基线。任何可选协议能力只在客户端声明支持且插件具备完整后端能力时公布。

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

## 阶段 B：对齐官方完整 Harness profile

### 目标

让独立 launcher 的 Harness 能力集合接近官方完整 profile，同时保持 transport 不承载领域逻辑。

### 交付

- 以官方 bundle/profile 组合和实际插件源码为权威来源，建立自动对账，避免在插件仓库维护易漂移的手写插件或命令清单；
- 组合 web search/fetch、增强文件搜索、LSP、持久终端、subagent、workflow、spill、tool-result pruning、timeout 与 loop guards；
- 仅把实际调用 `ctx.commands.register()` 的人类命令加入 ACP 目录，不把纯模型工具当作斜杠命令；
- 每个命令随其领域服务、provider 和 lifecycle policy 一起组合；
- 增加 package dependency closure、Cordis Loader、runtime closure 和官方 profile 差异检查。

### 验收

- 干净安装的插件可以在没有 Harness checkout 的目录中加载完整组合；
- 官方 profile 新增或移除人类命令、必要 provider 或关键 consumer 时，对账检查能够报告差异；
- 至少通过真实 ACP 流程执行新增的人类命令、工具、subagent 和 workflow 路径；
- 多 session、多连接和多 Zed 进程之间不共享派生状态或取消信号。

## 阶段 C：Additional directories 与 MCP

### 目标

接入 ACP 已稳定的额外工作区根目录，并允许 Zed 向 session 提供 MCP server 配置。

### 交付

- 在 `session/new`、`session/load` 和 `session/resume` 中校验并传递 `additionalDirectories`；
- 将额外根目录映射到 Harness filesystem、sandbox 和 observation policy，不改变主 `cwd` 的相对路径语义；
- 为每个 session 建立独立的 MCP server 生命周期、工具注册和 teardown；
- 对命令、skill、MCP 工具、文件访问与审批执行相同的 agent scope 校验；
- 明确处理不可执行 MCP transport、启动失败、取消和恢复时的配置变化。

### 验收

- read-only、workspace-write 和 danger-full-access 下的主目录与额外目录访问符合各自策略；
- 一个 session 的 MCP 工具、根目录或失败不会进入另一 session；
- load/resume 使用请求携带的完整根目录和 MCP 配置，不隐式复用其他连接的运行状态。

## 阶段 D：完整 Session 管理

### 目标

补齐大规模 session 历史的发现、删除和派生索引一致性。

### 交付

- 先在 Harness persistence capability 中增加跨 backend 的删除操作，再实现 ACP `session/delete`；
- 为 `session/list` 增加稳定 opaque cursor、分页和真实 `updatedAt`；
- 协调 JSONL 真源、attachment、checkpoint 和 session-query 派生索引的删除与对账；
- 在 ACP session fork 稳定且 Zed 支持后，将 Harness 的 session fork 投影到协议；
- 增加并发 list/load/resume/close/delete 与多进程恢复测试。

### 验收

- 删除不会由 ACP transport 直接操作 JSONL 文件或 SQLite 私有表；
- 分页过程中新增或更新 session 时，cursor 行为确定且不会重复或静默遗漏；
- close 只释放在线资源，delete 才删除持久历史，两者语义不会混合。

## 阶段 E：丰富内容与实时 UI

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

## 阶段 F：分发、认证、远程 transport 与 ACP v2

### 目标

将开发者安装方式升级为可发现、可诊断的发行体验，并为远程部署和下一代协议预留受控路径。

### 交付

- 发布 ACP Registry 元数据和标准安装配置；
- 实现 ACP authentication state、登录与 logout，并与模型 provider 凭据分开管理；
- 增加版本、配置来源、provider 加载和能力协商诊断，但不向 stdout 或日志泄露密钥；
- 在远程 transport 稳定后评估 HTTP/WebSocket 部署以及连接级身份隔离；
- 将 ACP v2 作为显式 opt-in compatibility preview，建立 v1/v2 双协议测试后再考虑默认切换。

### 验收

- 用户可以从 Registry 安装并启动插件，不需要手写源码路径；
- Agent 服务认证、模型 API 凭据和 Zed session 身份保持独立；
- 远程连接不能列出、恢复或操作其他身份拥有的 session；
- v2 Draft 变化不会破坏稳定 v1 用户。

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

按 `A → B → C → D → E → F` 推进。阶段 A 固定协议基线，阶段 B 完成 Harness 能力闭包；二者是后续工作的前置。阶段 C 和 D 分别扩展资源作用域与持久状态，必须在隔离与所有权规则稳定后实施。阶段 E 改善表现力，阶段 F 处理分发与下一代协议，不应提前迫使生产用户依赖 Draft 能力。
