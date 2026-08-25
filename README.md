# dsh-acp-interactive

中文 | [English](README.en.md)

面向编辑器的 Agent Client Protocol（ACP）JSON-RPC stdio 插件。它按需创建 DeepSeek Harness（dsh）agent，并把实时 session 事件投影为 ACP 消息、思考、工具卡片、审批、计划、标题、用量和命令更新。首个兼容目标是 Zed。

本插件只负责 UI transport。agent loop、模型 provider、工具、沙箱、子进程和审批策略仍由外围 Cordis 组合拥有；它与上游 automation-only ACP transport 相互独立。

`apply(ctx, config)` 需要 `agents`、`commands`、`llm`、`tools`、`sessionPersistence` 和 `sessionQuery`。它只回答自己创建的 agent 的审批请求，并把外来请求交给下一个监听器。一条连接可以拥有多个互相隔离的 session。组合 `permissionPresets` 服务后会增加权限 selector；缺少该服务时仍提供模型 selector。

## 安装

仓库发布 npm 包之前，可以直接从 GitHub 安装：

```sh
npm install github:cking000bigdemon/dsh-acp-interactive
```

GitHub 安装会运行本包的 `prepare` 构建脚本。建议锁定 commit（`github:cking000bigdemon/dsh-acp-interactive#<sha>`），并在授权安装脚本前审阅对应版本。

插件必须放进专用 ACP stdio 组合，不能加入普通控制台 profile，因为 stdout 只能传输 JSON-RPC 帧：

```yaml
- id: acp-interactive
  name: 'dsh-acp-interactive'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
```

| 配置 | 含义 |
|---|---|
| `provider` | 新建 agent 使用的可选 provider route。 |
| `model` | 新建 agent 使用的可选模型 id。 |

`stream` 只用于运行时测试。生产环境从 stdin 读取 ACP 帧，并保留 stdout 专门发送 ACP 帧。

## 协议能力

插件实现 `initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/list`、`session/load`、`session/resume` 和 `session/close`。文本与 reasoning 增量会立即流式发送。工具调用读取每个工具的 `presentCall` 和 `presentResult`，并把 `generic`、`diff` 和 `terminal` 展示意图映射为 ACP 卡片。`todo/write`、`session/title`、请求容量、provider 用量以及命令注册表变化会更新对应的客户端 session。

`session/list` 从 live 优先的查询语料库读取 session，按确定性的创建时间倒序返回，省略没有已记录绝对 cwd 的 session，支持精确 cwd 过滤，并尽可能附带日志中的标题。当前响应为不分页的完整结果；非 null cursor 会明确失败。

`session/load` 恢复持久化 dsh agent，并在返回前重放已组装的人类与 assistant 消息、reasoning、工具卡片、最新计划与标题、最终用量以及命令目录。它不会重放原始 assistant chunk，因此组装后的消息只出现一次。`session/resume` 恢复相同上下文但不发送历史。`session/close` 取消进行中的模型或命令工作，等待输出与 continuable 后代完全停稳，再释放精确归属的 agent。

当前支持文字 prompt 和直接斜杠命令。图片、resource link、音频、embedded resource、MCP server 和 additional directory 会被明确拒绝。恢复历史中出现丰富的人类、assistant 或工具结果 block 时也会失败，不会丢弃内容。Mode 和 elicitation 属于后续阶段。

## Session 配置

`session/new`、`session/load` 和 `session/resume` 返回完整的 ACP `configOptions`。模型 selector 按 provider 对 adapter 模型目录分组，并编码完整的 provider/model route。所选 route 在下一次 prompt assembly 时生效；恢复会话使用最后一条已记录 request header。客户端提交未公布的值会被拒绝。

组合 `permissionPresets` 后，权限 selector 会列出可用 preset。切换复用现有 `/permission` 命令，因此 sandbox mode、审批策略和持久事件保持一致。运行中的 session 拒绝权限变更；配置请求按 session 串行执行，prompt 不能越过尚未完成的切换。Selector 暂不提供独立的 reasoning-effort 控件。

## 工具执行与权限

ACP 不执行 dsh 工具。工具调用始终留在 harness 内，继续使用原有 cwd、沙箱、子进程、超时和生命周期策略。由本插件创建的 `approval/request` 会成为带 `allow_once` 和 `reject_once` 的 ACP permission request；取消仍是取消，未知选项不会获得授权。

Zed terminal 扩展按能力启用。客户端声明 `_meta.terminal_output` 后，terminal 展示意图会产生终端元数据和已捕获输出；其他客户端得到 fenced console 回退。location 和 diff 中的文件路径保持不变，因此 editor follow-along 打开的是工具实际操作的文件。

## 在 Zed 中连接

目前在 Windows 上验证的启动方式使用 DeepSeek Harness 源码 checkout 及其 `examples/acp-interactive-agent/cordis.yml` 组合。插件所在的 ACP 组合必须同时提供 session-persistence provider 与 session-query provider。在 Zed 打开 `Settings > AI > General > External Agents > Add Custom Agent`，分别填写：

| 字段 | 值 |
|---|---|
| Agent Name | `DeepSeek Harness` |
| Command | `C:\\Program Files\\nodejs\\node.exe` |
| Arguments | `--import=file:///D:/variFlight_work/deepseek-harness/node_modules/tsx/dist/loader.mjs D:/variFlight_work/deepseek-harness/packages/examples/acp-demo/src/bin.ts --config D:/variFlight_work/deepseek-harness/examples/acp-interactive-agent/cordis.yml` |
| Environment Variables | 名称填 `DEEPSEEK_API_KEY`，值填你的 key。 |

Command 和 Arguments 必须分别放进 Zed 对应字段。不需要 Zed 为 DeepSeek 编写专用代码，只需要它支持自定义 ACP agent。独立 launcher 不在当前包的职责范围内。

## 模型体验

普通 ACP 文字 prompt 会成为一条 human `user/message`，进入标准 dsh 请求，具有与其他 human message 相同的留存 token 成本。以斜杠开头的 prompt 通过 `ctx.commands` 解析；命令发现、输入和直接输出不进入模型历史，也不影响 KV cache，命令所拥有的领域变更可能影响后续请求。

消息、思考、工具卡片、审批、计划、标题、用量和命令更新只属于客户端，不增加 token，也不改变 KV cache 复用。工具结果和人工权限决定只通过普通 dsh tool-result 路径影响模型。

模型与权限 selector 的元数据和切换流量也只属于客户端。模型选择改变下一次请求记录的 provider/model；权限选择改变后续工具执行及外围 sandbox/approval 插件提供的权限说明。

## 已知限制与后续工作

- 未声明 `session/delete`。持久化 Service Definition 尚无跨 backend 的删除方法；本 transport 直接操作 JSONL 或 SQLite 会绕过持久化所有权与对账。
- `session/list` 当前返回一个完整页面且省略 `updatedAt`；稳定的 metadata cursor 与低成本最后活动时间观察应由 session-query 能力提供。
- Prompt 输入仅支持文字；更丰富的 ACP block 会失败，不会静默降级。
- 协作 mode、reasoning-effort 选择、用户问题 elicitation、MCP server 和 additional directory 延后实现。
- Terminal 输出在工具完成时发送，尚未增量推送。

## 开发

```sh
npm install
npm test
npm run typecheck
npm run build
```

设计与后续范围见[设计说明](docs/design.md)。

## 许可证

[MIT](LICENSE)
