# dsh-acp-interactive

中文 | [English](README.en.md)

面向编辑器的 Agent Client Protocol JSON-RPC stdio 服务器。它按需创建 dsh agent，并把实时 session 事件投影为 ACP 消息、思考、工具、审批、计划、标题、用量和命令更新。首个兼容目标是 Zed。

本包同时发布 UI transport 插件和 `dsh-acp-interactive` 可执行程序。transport 不承载领域逻辑；可执行程序加载随包发布的完整 Cordis 组合，因此普通用户无需安装或修改 DeepSeek Harness 源码。本 UI bridge 与上游 automation-only ACP transport 相互独立。

## 安装

发布到 npm 前，可以直接从 GitHub 全局安装并锁定到已审核的 commit：

```sh
npm install --global github:cking000bigdemon/dsh-acp-interactive#<sha>
```

GitHub 安装会运行本包的 `prepare` 构建脚本并安装 `dsh-acp-interactive` 命令。该命令加载包内经过评审的 editor profile，组合 DeepSeek 与用户 provider、agent spine、文件与本地 filesystem search、shell、权限、持久化、人类命令及 ACP transport。启动时，Windows 注册原生 `pwsh` 工具，Linux 和 macOS 注册 `bash` 工具；两套工具不会同时进入模型目录。stdout 只传输 JSON-RPC 帧。

需要自定义部署时，也可以只使用 transport export，并把它放进专用 ACP stdio 组合：

```yaml
- id: settings
  name: '@deepseek-ai/dsh-settings-file'

- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'

- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'

- id: acp-interactive
  name: 'dsh-acp-interactive'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
```

包内组合已经显式加载这三个 provider 依赖。`settings-file` 默认读取 `$DSH_HOME/settings.yaml`，`credentials-local` 解析同一个 dsh home 下的托管凭据，休眠挂载的 `llm-pi-ai` 则为 `llm-pi-ai.providers` 中的每条 route 动态注册模型。未设置 `DSH_HOME` 时使用当前用户的默认 `.dsh` 目录。因此 Pi Agent 桌面版与 Zed ACP 可以共享 provider、模型目录和凭据引用，无需把 API key 复制进 Zed 或 `cordis.yml`。profile 的 `apiKeyEnv` 必须与 `.credentials.yaml` 的 `refs` 键名一致。桌面版与 ACP server 仍是相互隔离的进程和 session。

`provider` 和 `model` 仅决定新 session 的初始 route，不会限制模型选择器。只要外围组合同时保留 DeepSeek adapter，Zed 就会按 provider 分组显示 DeepSeek 和用户配置的 OpenAI-compatible、Anthropic 或自定义网关模型。运行中修改 `settings.yaml` 后，provider 目录会由 settings 与 LLM registry 的现有动态更新路径刷新。

## 插件

`apply(ctx, config)` 需要 `agents`、`commands`、`llm`、`skills`、`tools`、`sessionPersistence` 和 `sessionQuery`。它只回答自己创建的 agent 的审批请求，并把外来请求交给下一个监听器。一条连接可以拥有多个互相隔离的 session；每个事件、选择、skill 查找和审批在进入 wire 前都会核对精确的 agent 对象。组合 `permissionPresets` 服务后会增加权限 selector；缺少该服务时模型选择仍然可用，而权限配置会省略。

| 配置 | 含义 |
|---|---|
| `provider` | 新建 agent 使用的可选 provider route。 |
| `model` | 新建 agent 使用的可选模型 id。 |

`stream` 只是运行时测试覆盖项。生产环境的 stdout 仅承载 ACP 帧，输入帧来自 stdin。

## 协议

插件实现 `initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/list`、`session/load`、`session/resume` 和 `session/close`。文本与 reasoning 增量会立即流式发送。工具调用读取每个工具的 `presentCall`、`presentResult` 和持久化的 `presentationMeta`；`generic`、`diff` 和 `terminal` 意图无需按工具名分支即可映射为 ACP 卡片。Editor profile 新增的 `glob`／`grep` 由 Harness 的已发布 filesystem-search 插件和随包 ripgrep 执行，仍走相同通用投影。`todo/write`、`session/title`、请求容量、provider 用量以及命令注册表变化会更新对应的客户端 session。

`session/list` 从 live 优先的查询语料库读取 session，按确定性的创建时间倒序返回，省略没有已记录绝对 cwd 的 session，支持精确 cwd 过滤，并尽可能附带日志中的标题。当前响应为不分页的完整结果；非 null cursor 会明确失败。

`session/load` 恢复持久化 dsh agent，并在返回前重放已组装的人类与 assistant 消息、reasoning、图片、工具卡片、最新计划与标题、最终用量以及命令目录。它不会重放原始 assistant chunk，因此组装后的消息只出现一次。`session/resume` 恢复相同上下文但不发送历史。`session/close` 取消进行中的 prompt 准入、skill 发现、模型或命令工作，等待输出与 continuable 后代静止，再释放精确归属的 agent。

ACP 命令目录会合并精确 agent 的 `ctx.commands` 视图，以及按其 cwd 与 scope 发现的 `userInvocable` skill。真实命令与同名 skill 冲突时由命令胜出。`commands/change` 和 `skills/change` 会触发按 session 的完整替换更新；skill 观察不完整或失败时保留上一次完整条目，完整空结果会删除旧条目。以 `/<skill-name>` 开头的输入若仍能解析为用户可调用定义，就进入普通用户消息路径，由 `@deepseek-ai/dsh-tool-skill` 完成标准、已落账的 `agent/pre-step` 注入。未知斜杠名称仍是未知命令；仅限模型的 skill 既不公布，也不接受为 ACP 显式 skill 调用。

命令目录本身不声明领域命令；包内 editor profile 挂载 `/permission`、`/plan`、`/compact`、`/goal` 和 `/feedback` 及其对应 domain/provider，目录仍只从实际的 `ctx.commands.register()` 动态发现。该 bridge 只执行已注册的 command，不把模型工具误当作斜杠命令。

当前支持文字、resource link 和内联光栅图片 prompt。Resource link 会成为持久用户消息中明确的方括号引用。组合 attachment store 后，初始化会声明图片输入；每张图片都会针对所选模型 route 完成校验和持久化后才排入消息，因此 session 日志只保存 durable reference。重放时，图片会经校验后成为内联 ACP 内容。音频、embedded resource、MCP server 和 additional directory 会被明确拒绝；Additional directories 的领域能力由独立的 `dsh-additional-directories` DSH 插件项目负责。直接斜杠命令仍只接受文字。

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

## 在 Zed 中运行

安装后，在 Zed 中直接登记随包安装的命令。Windows 可用 `where.exe dsh-acp-interactive` 确认绝对路径：

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

Zed 会以当前工作区作为 server cwd；JSONL session 存在该工作区的 `.sessions`，每个 server 进程使用独立的内存 SQLite session-query 索引。多个编辑器进程可以共享 JSONL 真源而不会争用派生索引。无需 DeepSeek Harness checkout，也无需 Zed 编写 DeepSeek 专用代码。

受支持版本与能力验证状态见 [Zed 兼容矩阵](docs/compatibility.md)。当前发布以 ACP SDK `1.4.0` 的稳定 v1 schema 为基线。

显式配置支持图片的模型时，必须声明输入模态。例如：

```yaml
- id: deepseek-v4-flash-vision-exp
  inputModalities: [text, image]
```

缺少该元数据时，DeepSeek adapter 会把显式目录项视为纯文字模型，bridge 会在 prompt 入队前拒绝图片。

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

#### Token 影响

ACP 更新不增加模型 token。工具结果保留普通 dsh 模型可见成本。

#### KV Cache 影响

UI 投影不影响复用。工具结果通过标准 session surface 追加，并产生该路径通常具有的 cache 影响。

### 模型、reasoning、mode 与权限控件

#### 模型看到什么

Selector 与 mode 元数据仅属于客户端。模型和 reasoning 选择会改变下一次已组装请求所记录的 route 字段。Plan mode 通过 `ctx.planMode` 改变标准 plan 指引与退出工具行为。权限选择会改变后续工具执行，以及 sandbox 和 approval 插件拥有的标准权限说明。

#### Token 影响

这些控件本身不增加模型 token。所选 route 和 effort 遵循该模型通常的 token 行为；plan mode 会加入配置的指引；权限 preset 只产生其既有 policy 投影的 token 影响。

#### KV Cache 影响

改变 provider 或模型后，下一次请求开始使用该 route 的 cache identity。改变 reasoning effort 或 plan 指引会改变请求及其可复用前缀。权限选择遵循既有 sandbox/approval 投影行为，不会把 ACP 流量加入 prompt。

## 已知限制与后续工作

- 未声明 `session/delete`。持久化 Service Definition 尚无跨 backend 的删除方法；transport 直接操作 JSONL 或 SQLite 会绕过持久化所有权与对账。
- `session/list` 当前返回一个完整页面且省略 `updatedAt`；稳定的元数据 cursor 与低成本最后活动时间观察应由 session-query 能力提供。
- 音频和 embedded-resource prompt block 会失败，不会静默降级。Prompt 与消息历史已经支持图片，但工具结果图片卡片仍只投影文字。
- Session cost 只在 Harness 后端提供可靠的累计金额和币种后才会发送；当前不会按 token 价格猜测成本。
- MCP server 延后实现；Additional directories 不在本仓库实现，由独立的 `dsh-additional-directories` DSH 插件项目负责。
- Terminal 输出在工具完成时发送，尚未增量推送。

## 开发

```sh
npm install
npm test
npm run typecheck
npm run build
npm run check:profile
npm run verify:packed
```

独立仓库不在运行时依赖 DeepSeek Harness checkout。开发兼容性检查使用只读的官方 checkout：设置 `DSH_HARNESS_ROOT` 后运行 `npm run test:harness`，或在仓库旁放置 `../deepseek-harness`。该命令复制当前官方 `packages/acp/acp-interactive/tests` 到忽略的临时目录，并用本仓库 `src/` 执行。`check:profile` 对账当前官方 bundle/profile 中的候选包、人类命令、必要 provider 和关键 consumer，只报告需要评审的差异，不改写发布组合；`verify:packed` 从 tarball 在仓库外干净安装并启动真实 ACP launcher。`npm run test:all` 串联仓库、官方兼容和 profile 对账检查。

已实现范围见[设计说明](docs/design.md)，推荐开发顺序与各阶段验收条件见[后续开发路线图](docs/roadmap.md)。

## 许可证

[MIT](LICENSE)
