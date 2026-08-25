# dsh-acp-interactive

中文 | [English](README.en.md)

面向编辑器的 Agent Client Protocol（ACP）JSON-RPC stdio 插件。它按需创建 DeepSeek Harness（dsh）agent，并把实时 session 事件投影为 ACP 消息、思考、工具卡片、审批、计划、标题、用量和命令更新。首个兼容目标是 Zed。

本插件只负责 UI transport。agent loop、模型 provider、工具、沙箱、子进程和审批策略仍由外围 Cordis 组合拥有；它与上游 automation-only ACP transport 相互独立。

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

插件实现 `initialize`、`session/new`、`session/prompt` 和 `session/cancel`。文本与 reasoning 增量会立即流式发送。工具调用读取每个工具的 `presentCall` 和 `presentResult`，并把 `generic`、`diff` 和 `terminal` 展示意图映射为 ACP 卡片。`todo/write`、`session/title`、请求容量、provider 用量以及命令注册表变化会更新对应的客户端 session。

当前支持文字 prompt 和直接斜杠命令。图片、resource link、音频、embedded resource、MCP server 和 additional directory 会被明确拒绝。持久 session 发现与加载、模型／配置 selector、mode 和 elicitation 尚未提供。

## 工具执行与权限

ACP 不执行 dsh 工具。工具调用始终留在 harness 内，继续使用原有 cwd、沙箱、子进程、超时和生命周期策略。由本插件创建的 `approval/request` 会成为带 `allow_once` 和 `reject_once` 的 ACP permission request；取消仍是取消，未知选项不会获得授权。

Zed terminal 扩展按能力启用。客户端声明 `_meta.terminal_output` 后，terminal 展示意图会产生终端元数据和已捕获输出；其他客户端得到 fenced console 回退。location 和 diff 中的文件路径保持不变，因此 editor follow-along 打开的是工具实际操作的文件。

## 在 Zed 中连接

目前在 Windows 上验证的启动方式使用 DeepSeek Harness 源码 checkout 及其 `examples/acp-interactive-agent/cordis.yml` 组合。在 Zed 打开 `Settings > AI > General > External Agents > Add Custom Agent`，分别填写：

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
