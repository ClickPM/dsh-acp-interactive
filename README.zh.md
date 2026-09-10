# dsh-acp-interactive

[![npm](https://img.shields.io/npm/v/deepseekharness-acp-interactive)](https://www.npmjs.com/package/deepseekharness-acp-interactive)
[![CI](https://github.com/ClickPM/dsh-acp-interactive/actions/workflows/ci.yml/badge.svg)](https://github.com/ClickPM/dsh-acp-interactive/actions/workflows/ci.yml)
[![Registry auth check](https://github.com/ClickPM/dsh-acp-interactive/actions/workflows/registry-auth.yml/badge.svg)](https://github.com/ClickPM/dsh-acp-interactive/actions/workflows/registry-auth.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) | 中文

面向编辑器的 Agent Client Protocol JSON-RPC stdio 服务器。它按需创建 dsh agent，并把实时 session 事件投影为 ACP 消息、思考、工具、审批、计划、标题、用量和命令更新。首个兼容目标是 Zed。

本包同时发布 UI transport 插件和 `dsh-acp-interactive` 可执行程序。transport 不承载领域逻辑；可执行程序加载随包发布的完整 Cordis 组合（`config/cordis.yml`）——DeepSeek 与用户 provider、agent spine、模型生成的会话标题、文件与 filesystem-search 工具、进程内 subagent、shell、权限、持久化、人类命令及 ACP transport——因此普通用户无需安装或修改 DeepSeek Harness 源码。本 UI bridge 与上游 automation-only ACP transport 相互独立。

`dsh-acp-interactive` 是独立的社区维护项目，与 DeepSeek 和 Zed Industries 没有隶属或背书关系；它把已发布的 `@deepseek-ai/dsh-*` 包组合在经过评审的 editor profile 之后，不自称 DeepSeek 官方 ACP agent。

## 快速开始

```sh
npm install --global deepseekharness-acp-interactive
dsh-acp-interactive --setup
```

`--setup` 通过 Harness 凭据存储保存 `DEEPSEEK_API_KEY`，不会回显。然后在 Zed 的 `settings.json`（按 `Ctrl+Shift+P` / `Cmd+Shift+P` 输入 `zed: open settings` 打开）中登记已安装的命令；Windows 上使用 `where.exe dsh-acp-interactive` 打印的绝对路径（注意使用正斜杠 `/` 或双反斜杠 `\\`），macOS / Linux 上使用 `which dsh-acp-interactive`：

```json
{
  "agent_servers": {
    "dsh-acp-interactive": {
      "type": "custom",
      "command": "C:/Users/you/AppData/Roaming/npm/dsh-acp-interactive.cmd",
      "args": []
    }
  }
}
```

保存后，在 Zed 的 Agent 面板（快捷键 `Ctrl+?` / `Cmd+?`）顶部的下拉列表中选择 `dsh-acp-interactive` 即可启用。Zed 以当前工作区作为 server cwd，JSONL session 存在该工作区的 `.sessions`；每个 server 进程使用独立的内存 SQLite session-query 索引，因此多个编辑器进程可以共享 JSONL 真源而不争用派生索引。

跳过 `--setup` 也可以：没有存好 key 时新开的线程会显示 `Configure DeepSeek API key` 操作，点击后运行同一个流程（见[认证](#认证)）；不支持 terminal authentication 的客户端则以 agent 类型方法收到同样的说明。

发布的 tarball 已包含构建好的 `lib/`，安装时不运行构建步骤。每个已发布版本都对应一个 `vX.Y.Z` tag 和一条 [GitHub Release](https://github.com/ClickPM/dsh-acp-interactive/releases)，其附件包含 tarball 及其 SHA-256 校验值，因此安装结果可以对照打 tag 的源码审计。受支持版本与能力验证状态见 [Zed 兼容矩阵](docs/compatibility.md)；当前发布以 ACP SDK `1.4.0` 的稳定 v1 schema 为基线。

## 在 Zed 中的样子

![Zed agent 面板中运行 DeepSeek Harness Interactive，旁边是编辑器，输入框底部有模型、推理强度和权限选择器](assets/zed-overview.png)

`/` 面板列出从已组合的 Harness 插件中发现的人类命令；权限与推理强度选择器是 ACP session 配置项，分别由 Harness 权限 preset 和所选模型公布的 effort 支撑。

![斜杠命令面板：compact、feedback、goal、permission、plan](assets/zed-commands.png)

![权限 preset 选择器（read-only、workspace-write、danger-full-access）与推理强度选择器（Default、Off、Low、High、Max）](assets/zed-controls.png)

### 认证

没有存储 key 时新开线程，`session/new` 返回 `auth_required`，Zed 随即展示 `Configure DeepSeek API key` 操作和 agent 自己给出的说明。点击后 Zed 以终端任务运行 `--setup`；该终端退出后，Zed 用存好的 key 重试 `session/new`。

![Zed 的认证面板："Authenticate to DeepSeek Harness"、Configure DeepSeek API key 按钮，以及 DEEPSEEK_API_KEY 未配置的提示](assets/zed-auth.png)

![点击之后：线程显示 "Authenticating to DeepSeek Harness…"，Zed 正在运行 Configure DeepSeek API key 终端任务](assets/zed-auth-terminal.png)

### 权限

工具调用在 Harness 沙箱内执行。`read-only` preset 下的写入会被拒绝并附带沙箱的升级提示；重试的调用以 ACP permission request 的形式到达 Zed，给出 `Allow once` / `Reject`，批准后的写入及其回读以工具卡片呈现。

![read-only 下被拒绝的写入，随后升级后的写入等待 Allow once 或 Reject](assets/zed-permission.png)

![批准后的写入卡片及其内容、回读，以及创建出的文件](assets/zed-edit-result.png)

## 1.3.0 新增

`1.3.0` 加入进程内 subagent。组合 profile 装配已发布的 `@deepseek-ai/dsh-subagent` 注册表、`spawn` 与 `fork` 两个 backend，以及 `subagent`、`subagent_fork` 两个委托工具：模型把一个独立任务或需要沿用本对话的任务委托出去，并以工具结果收到子 agent 的最终回答。在 Zed 中，一次委托就是一张工具卡片——运行期间子 agent 自己的工具调用、回复、嵌套委托与结算折叠为卡片内有界的 transcript，父 agent 的工具结果结算卡片。委托只在父 turn 内前台等待；子 agent 继承父 session 的 sandbox mode、approval 固定为 `never`，不会发起 ACP permission request；子 session 也不是编辑器会话。见 [In-Process Subagents Agent Note](docs/agent-notes/2026-09-10-in-process-subagents.md)，更早版本见[更新日志](CHANGELOG.zh.md)。

## 配置

状态保存在 dsh home（`$DSH_HOME`，未设置时为当前用户默认的 `.dsh` 目录）：`settings.yaml` 保存 provider 与模型目录，`.credentials.yaml` 保存凭据。因此 Pi Agent 桌面版与 Zed ACP 可以共享 provider、模型目录和凭据引用，无需把 API key 复制进 Zed 或 `cordis.yml`；profile 的 `apiKeyEnv` 必须与 `.credentials.yaml` 的 `refs` 键名一致，两者仍是相互隔离的进程和 session。运行中修改 `settings.yaml` 后，provider 目录会由 settings 与 LLM registry 的现有动态更新路径刷新；休眠挂载的 `llm-pi-ai` 为 `llm-pi-ai.providers` 中的每条 route 动态注册模型。

启动时，Windows 注册原生 `pwsh` 工具，Linux 和 macOS 注册 `bash` 工具；两套工具不会同时进入模型目录。stdout 只传输 JSON-RPC 帧。

显式配置支持图片的模型时必须声明输入模态，否则 DeepSeek adapter 会把该目录项视为纯文字模型，bridge 会在 prompt 入队前拒绝图片：

```yaml
- id: deepseek-v4-flash-vision-exp
  inputModalities: [text, image]
```

需要自定义部署时，也可以只使用 transport export，并把它放进专用 ACP stdio 组合；其中 `provider` 和 `model` 仅决定新 session 的初始 route，不会限制模型选择器：

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

## 实现了什么

- `initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/list`、`session/load`、`session/resume`、`session/close`。
- 流式文本与 reasoning，按各工具自身展示意图（generic、diff、terminal）生成的工具卡片，subagent 委托卡片，计划，模型生成的会话标题，用量，以及审批请求。
- Session 配置项：provider/模型 route、reasoning effort、plan mode 和 Harness 权限 preset，均可在运行中的 session 内切换。
- 逐 session 归属的 MCP：稳定 ACP v1 的 stdio 与 Streamable HTTP server，运行在逐 session 私有的 Cordis root 中，工具名为确定性的 `mcp__<server>__<tool>`。
- 合并精确 agent 的 `ctx.commands` 视图与按其 cwd 发现的用户可调用 skill 的命令目录；包内 profile 挂载 `/permission`、`/plan`、`/compact`、`/goal` 和 `/feedback`。
- 文字、resource link 与内联图片 prompt，以及通过 ACP form elicitation 的结构化提问。

完整行为——插件契约、认证、各方法语义、配置投影、工具执行，以及各能力面对 token 与 KV cache 的影响——见[行为参考](docs/reference.md)。

## 已知限制

- 未声明 `session/delete`。持久化 Service Definition 尚无跨 backend 的删除方法；transport 直接操作 JSONL 或 SQLite 会绕过持久化所有权与对账。
- `session/list` 当前返回一个完整页面且省略 `updatedAt`；稳定的元数据 cursor 与低成本最后活动时间观察应由 session-query 能力提供。
- 音频和 embedded-resource prompt block 会失败，不会静默降级。Prompt 与消息历史已经支持图片，但工具结果图片卡片仍只投影文字。
- Session cost 只在 Harness 后端提供可靠的累计金额和币种后才会发送；当前不会按 token 价格猜测成本。
- MCP 仅支持稳定 v1 的 stdio 与 Streamable HTTP 配置，legacy SSE 和 ACP 代理 transport 会被拒绝；Additional directories 仍不在本仓库实现，由独立的 `dsh-additional-directories` DSH 插件项目负责。
- Terminal 输出在工具完成时发送，尚未增量推送。
- Subagent 只在前台运行。`run_in_background`、continuable child、`send_message`、`interrupt_agent`、`list_agents` 以及进程外 ACP／Codex／Claude Code backend 均未组合。恢复的会话只重放委托的结算结果卡片，不带子 agent transcript；稳定 ACP 尚无子会话能力，因此卡片以 `_meta.dsh_subagent` 携带子 session id，而不是可跳转的子线程。

## 验证与 ACP Registry

- [CI](https://github.com/ClickPM/dsh-acp-interactive/actions/workflows/ci.yml) 在每次 push 和 pull request 时于 Ubuntu、macOS、Windows 与 Node `22.19`、`24` 上运行：`npm ci`、typecheck、构建与测试、pack dry run，以及 `verify:packed`——它把打包后的 tarball 安装到仓库之外，运行 `--setup`，并驱动真实 launcher 完成 `initialize`、带 session 级 MCP server 的 `session/new` 和 `session/close`。
- [Registry auth check](https://github.com/ClickPM/dsh-acp-interactive/actions/workflows/registry-auth.yml) 把 [`registry/agent.json`](registry/agent.json) 与 [`icon.svg`](icon.svg) 放进 [agentclientprotocol/registry](https://github.com/agentclientprotocol/registry) 的全新 clone，并用该仓库自己的 `build_registry.py --dry-run` 和 `verify_agents.py --auth-check` 对已发布的 npm 包做校验：每日运行、可手动触发（`gh workflow run registry-auth.yml -f version=<x.y.z>`），并在 release 工作流发布版本后由其触发。
- [Release](https://github.com/ClickPM/dsh-acp-interactive/actions/workflows/release.yml) 在 `v*.*.*` tag 上运行，重新验证打 tag 的代码树，通过 npm trusted publishing 发布（普通 CI 不持有发布 token），并把 tarball 和 `SHA256SUMS.txt` 附加到 GitHub Release。
- Registry 提交：[agentclientprotocol/registry#585](https://github.com/agentclientprotocol/registry/pull/585)。`npm run check:registry` 在本地把条目和图标与 `package.json` 对照校验。

## 开发

```sh
npm install
npm test
npm run typecheck
npm run build
npm run check:profile
npm run check:registry
npm run verify:packed
```

本仓库不在运行时依赖 DeepSeek Harness checkout。官方兼容测试门使用只读的官方 checkout：设置 `DSH_HARNESS_ROOT` 或在仓库旁放置 `../deepseek-harness` 后运行 `npm run test:harness`——它按 `config/upstream-baseline.json` 记录的固定 ref 提取官方 ACP spec（不读取 checkout 的工作树状态）到忽略的临时目录，用本仓库 `src/` 执行其中标记为 aligned 的断言，其余官方 spec 逐个记录为附理由的显式分歧，并在固定 ref 新增、移除或重命名 spec 时失败，使变化进入评审而不是被静默跳过。`check:profile` 对账官方候选包、人类命令、必要 provider 和关键 consumer，只报告需要评审的差异，不改写发行组合；`verify:packed` 从 tarball 在仓库外干净安装并启动真实 ACP launcher。`npm run test:all` 串联仓库测试、官方兼容测试和 profile 对账。

已实现范围见[设计说明](docs/design.md)，推荐开发顺序与各阶段验收条件见[后续开发路线图](docs/roadmap.md)，ACP 能力面的完整行为见[行为参考](docs/reference.md)。

## 许可证

[MIT](LICENSE)
