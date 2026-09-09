# 上游贴合、公开 CI 与 Zed 验证规范

中文 | [English](upstream-alignment.en.md)

本文定义 `dsh-acp-interactive` 在 `1.0.3` 之后的产品方向和质量优化顺序。项目不以追赶其他社区 ACP 实现的功能数量为目标，而以贴近已发布的 DeepSeek Harness 架构、提供可审计的独立发行包、建立公开持续验证和提供真实 Zed 使用证据为优先事项。

相关架构决定见 [Upstream-Aligned Product Direction Agent Note](agent-notes/2026-09-08-upstream-aligned-product-direction.md)。具体协议能力仍以[设计说明](design.md)、[开发路线图](roadmap.md)和 [Zed 兼容矩阵](compatibility.md)为准。

## 产品原则

### 1. 上游领域所有权优先

Harness 已经提供的模型调用、agent loop、工具执行、凭据、权限、沙箱、skill、持久化、session query、compaction 和生命周期行为，只通过其已发布插件组合和消费。本仓库不在 ACP transport 中复制这些领域实现。

ACP 层只拥有编辑器协议适配、能力协商、事件投影、连接输出排序，以及 ACP 请求与精确 Harness session/agent 生命周期之间的绑定。

### 2. 组合优先于重新实现

新增能力必须先确认 Harness 是否已经提供稳定且已发布的 Service Definition、Provider、Consumer 和生命周期策略。完整闭包可用时，由 editor profile 显式评审后组合；闭包不存在时，能力保持不公布、明确拒绝或延期，不为了补齐功能表而在本仓库建立平行领域实现。

`config/cordis.yml`、`config/editor-profile.json`、`package.json` 和 lockfile 共同构成发行组合。每个 bare plugin 都必须是直接 runtime dependency，profile 漂移只能报告，不能未经评审自动改变用户行为。

### 3. 完整能力闭包后才公布

可选 ACP 能力只有同时满足以下条件才可以 advertise：

1. 对应 Harness 服务已完整组合；
2. 客户端声明支持所需的稳定 ACP 能力或经评审的兼容字段；
3. 安装包中的真实 launcher 已验证该路径；
4. session、连接、agent、cwd、skill、审批、模型、MCP 和取消所有权保持精确隔离；
5. 取消、失败、恢复和 teardown 有确定行为。

内部 Harness 策略不因为已组合就自动成为 ACP capability。ACP 只投影其可见结果和明确错误。

### 4. 正确性和上游兼容优先于功能数量

session fork、LSP、未保存缓冲区、embedded context、compaction UI 或其他社区实现已经提供的能力，不自动进入本项目路线图。只有在以下条件成立时才评估：

- Zed/ACP 存在明确且稳定的需求和协议面；
- Harness 上游已经提供适合复用的领域闭包；
- editor profile 能维持安装独立性、能力协商和生命周期隔离；
- 维护成本不会迫使 ACP transport 接管上游领域行为。

不以功能数量、方法数量或与其他 Agent 的表格对齐作为发布标准。

### 5. 安装产物独立，上游源码仅作开发夹具

发布到 npm 的包必须在没有 DeepSeek Harness 源码 checkout 的干净目录中安装、启动和完成核心 ACP 流程。官方 checkout 只用于兼容测试、profile 对账和候选能力评审，不能成为安装、启动或运行时依赖。

### 6. 模型上下文与 UI 投影分离

模型可见内容必须先由 Harness 写入 durable session log，再进入请求组装。只服务于 Zed UI 的 ACP message、thought、tool card、diff、terminal、plan、title、usage 和目录更新不进入模型上下文，也不能改变 Harness 的权限或文件访问边界。

### 7. 证据分级，不把推断写成实测

文档必须区分：

- schema/type 层协议兼容；
- 模拟 Zed capabilities 的自动契约测试；
- 真实打包 launcher 的 ACP 测试；
- 真实 Zed Stable/Preview UI 人工验收。

只有最后一层可以标记“真实 Zed 已验证”。从 Zed 源码、release notes 或 SDK 推导出的结论必须明确标记为契约或兼容性推断。

### 8. 来源与许可证采用最小、可审计处理

本项目原创部分继续采用 MIT。上游删除历史文件不作为判断当前代码来源的唯一依据；对仍保留的历史衍生内容按实际代码来源审计，并只保留适用于这些内容的必要版权和许可证声明。项目不因局部第三方声明而整体切换许可证，也不恢复与当前发行无关的历史许可结构。

## 持续验证模型

### 发行包验证：阻塞合并和发布

该路径只使用本仓库和 lockfile 安装的公开 npm 包，必须在支持的平台上通过：

1. `npm ci`
2. `npm run typecheck`
3. `npm test`
4. `npm pack --dry-run`
5. `npm run verify:packed`
6. packed tarball 干净安装
7. 真实 launcher 的 `initialize → session/new → session/prompt → session/cancel/close` ACP smoke flow
8. Registry stable/legacy terminal-auth initialize probe
9. `git diff --check`

这条路径证明用户实际获得的发布产物可以独立运行，不允许通过 sibling checkout、workspace link 或未打包文件补齐依赖。

### 固定上游兼容：阻塞发布

仓库记录一个已知兼容的 DeepSeek Harness 官方 tag 或 commit。CI 使用该固定版本运行可用的官方兼容测试和 editor-profile reconciliation。固定基线升级必须经过显式 PR，说明：

- 官方包和服务变化；
- profile 新增、移除或继续延期的候选能力；
- 破坏性协议或生命周期变化；
- package/profile/lockfile 是否同步。

官方版本不再提供某个历史测试路径时，脚本必须给出明确的 `fixture unavailable` 诊断；不得把“测试不存在”伪装成通过，也不得为了保持绿色而修改官方 checkout。

### 最新上游观察：定时、可见、初期不阻塞

定时任务和手动 workflow 对 DeepSeek Harness 默认分支执行 profile drift、类型或兼容观察。该任务用于尽早发现上游变化，不自动升级依赖或修改发行组合。

初期允许它作为非阻塞任务，但失败必须在 Actions 中可见并形成可跟踪事项。某个最新上游版本被正式纳入支持范围前，必须先转化为固定基线并通过完整发行验证。

## 公开 CI 优化

### Required CI

GitHub Actions 使用以下矩阵：

| 平台 | Node |
| --- | --- |
| Ubuntu | 最低支持的 `22.19.x`、当前 `24.x` |
| macOS | 最低支持的 `22.19.x`、当前 `24.x` |
| Windows | 最低支持的 `22.19.x`、当前 `24.x` |

每条矩阵腿至少运行 `npm ci`、typecheck、项目测试、build、pack dry-run 和 packed-install 验证。真实平台 shell、stdout 纯净性和取消测试不能因为 runner 环境不方便而静默 skip；平台前置能力缺失时应明确失败或拆到有完整前置能力的专用任务。

### 独立质量任务

- `registry-auth`：用 Registry 的 initialize payload 验证 terminal auth；
- `launcher-smoke`：从 tarball 安装并运行核心 ACP 会话；
- `upstream-pinned`：验证固定 Harness 基线；
- `upstream-latest`：定时观察官方默认分支；
- `package-audit`：核对 Cordis bare plugins、runtime dependencies、packlist 和版本；
- `release`：只由显式版本 tag 触发，生成 GitHub Release，并使用 npm trusted publishing/provenance；普通 CI 不持有发布 token。

README 应公开显示 npm version、CI 和许可证状态，但 badge 只能代表对应 workflow 实际执行的范围。

## 真实 Zed 验证

### 自动契约层

从受支持 Zed 版本的源码或捕获握手中维护版本化 `clientCapabilities` fixture。真实打包 launcher 至少验证：

- 按客户端能力协商的 terminal auth 公布，以及 agent 类型回退方法；
- prompt modality、MCP 和 session lifecycle capability；
- message ID 与 request cancellation；
- model、reasoning 和 permission config；
- form elicitation；
- terminal presentation fallback；
- 未声明能力时不公布、不调用或明确拒绝。

fixture 必须记录来源 Zed 版本和 commit，升级 fixture 时评审 capability 差异。

### Stable/Preview 人工验收层

每个准备对外声明 Zed 兼容的行为版本，至少在一个受支持操作系统上对 Zed Stable 完成真实安装验证；影响能力协商、终端认证或新 ACP 字段的版本还应验证 Zed Preview。

验收清单至少包括：

1. 从 pack/npm 产物启动，而不是从源码目录启动；
2. `initialize` 和首次 `--setup` Terminal Auth；
3. 新建会话并收到流式 message/reasoning；
4. shell terminal card 和文件 diff；
5. permission allow/reject；
6. model/permission selector；
7. session close 后 list/load/resume；
8. 取消一个 session 的请求且另一 session 不受影响；
9. MCP 启动、调用、取消和 teardown（发布涉及 MCP 时）；
10. stdout 只包含 ACP JSON-RPC frames。

结果记录在版本化报告中，包含 Zed、操作系统、Node、npm 包版本、每项结论和必要的脱敏证据。失败项和未测项必须保留，不能用协议推断替代。

## 优化步骤与验收门

### Q0：来源审计与声明边界

- 比较当前仍保留的实现与历史上游来源；
- 记录原创、修改和仍可识别的衍生部分；
- 只为实际保留内容加入必要第三方声明；
- 不改变本项目原创代码的 MIT 许可。

验收：来源决定可由文件和历史证据复核，发布包包含所有适用声明，没有把“上游已删除”当作唯一判断。

### Q1：公开跨平台 CI

- 建立 Ubuntu/macOS/Windows 与 Node 22.19/24 矩阵；
- 增加 Registry auth、packed launcher、package closure 和 stdout guard；
- 将 required checks 设为分支合并门；
- README 展示真实 CI 状态。

验收：新贡献者和 Registry 维护者无需访问开发机即可查看支持平台的完整结果。

### Q2：上游兼容流水线

- 记录固定 Harness tag/commit；
- 让 `check:profile` 和可用的 `test:harness` 在固定基线上运行；
- 增加最新上游定时观察；
- 为 fixture 缺失、profile drift 和真实失败定义不同诊断。

验收：已支持上游与最新上游的状态不会混淆，任何升级都通过显式评审进入发行基线。

### Q3：真实 Zed 验证

- 建立版本化 Zed capability fixture；
- 增加契约测试；
- 在 Stable/Preview 执行人工 smoke checklist；
- 保存脱敏报告、截图或短视频。

验收：Registry PR 和 README 可以链接到一次可复核的真实 Zed 验证，而不是只引用 release notes。

### Q4：发行与 Registry 证据

- 创建正式 GitHub Release；
- 建立可审计、无长期 npm token 的发布流程；
- 在 Registry PR 中链接公开 CI、上游基线和 Zed 报告；
- 将项目描述聚焦为 composition-first、upstream-aligned，而不是功能最多。

验收：Registry 审核者可以从公开链接确认包来源、测试、上游关系、认证和真实 Zed 行为。

## 当前非目标

- 不为了与其他社区实现对齐而复制 session fork、LSP、未保存缓冲区或 compaction UI；
- 不把 DeepSeek Harness 源码 checkout 变成用户安装条件；
- 不在 ACP transport 中修补 Harness 领域服务缺口；
- 不声称获得 DeepSeek 或 Zed 官方背书；
- 不把自动契约测试描述成真实 Zed UI 验收；
- 不通过长期个人 npm token 完成自动发布。

## 当前优先顺序

在恢复路线图中的新功能开发前，质量工作按 `Q0 → Q1 → Q2 → Q3 → Q4` 推进。Q0 只解决当前仍保留内容的来源与声明边界；Q1 建立公开证据；Q2 固定与观察上游；Q3 验证真实客户端；Q4 汇总为发行和 Registry 审核材料。除正确性、安全或上游兼容修复外，功能丰富度不应打断该顺序。

截至 `1.0.4`：Q1 的跳平台 CI 矩阵、Q4 的 tag 驱动发布流程，以及保存在仓库内并由 Registry 自身校验脚本复查的 Registry 条目均已落地，见 [Public CI and Registry Evidence Agent Note](agent-notes/2026-09-09-public-ci-and-registry-evidence.md)。

截至 `1.1.0`：Q2 的固定上游基线已落地。`config/upstream-baseline.json` 记录已评审的官方 ref，`npm run test:harness` 从该 ref 提取 spec 而不再读取 checkout 工作树，每个官方 spec 必须被分类为 aligned 或附理由的 divergent，未分类或消失的 spec 以 `fixture unavailable` 失败，见 [Upstream 0.1.2-rc.1 Baseline Agent Note](agent-notes/2026-09-09-upstream-0.1.2-rc.1-baseline.md)。trusted publishing 的启用、Q0、Q2 的最新上游定时观察和 Q3 仍待完成。
