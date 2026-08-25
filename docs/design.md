# Zed 交互式 ACP 插件方案

## 目标

`dsh-acp-interactive` 是独立的 Cordis 插件，让 Zed 通过 Agent Client Protocol（ACP）获得接近 Codex ACP 和 Claude ACP 的交互体验。Zed 负责会话界面、流式内容、工具卡片、审批控件和计划展示；DeepSeek Harness（dsh）继续负责模型调用、agent loop、工具执行、工作目录、沙箱、权限策略和生命周期。

这不是 Codex 插件，也不是 Zed 扩展。协议适配器作为 dsh 插件运行，通过 JSON-RPC stdio 与 Zed 通信。

## 是否需要官方支持

运行不需要 Zed 为 DeepSeek 或 dsh 增加专用内置支持。只要当前 Zed 版本支持在 `agent_servers` 中启动自定义 ACP agent，就可以把 dsh 的启动命令配置进去。Zed 官方支持会影响 Registry 一键安装、非标准 `_meta` 扩展和新 ACP 功能的兼容速度，但不是第一阶段的前置条件。

DeepSeek 官方同样不需要修改 API。适配器连接的是 dsh 的 agent 和事件模型；实际模型仍由现有 `dsh-llm-deepseek` provider 选择。

## 包边界

- `@deepseek-ai/dsh-acp` 保持 automation-only，继续服务程序化 ACP 客户端和进程外 subagent。
- `dsh-acp-interactive` 是面向编辑器和人的独立 UI transport，不被 automation ACP 的最小协议面约束。
- DeepSeek Harness 上游源码中的 `examples/acp-interactive-agent/cordis.yml` 提供可直接被 Zed 启动的组合；本仓库不包含独立 launcher。
- ACP 只投影 dsh 已经拥有的状态，不让 Zed 代替 dsh 执行工具或扩大文件访问范围。

## 数据流

```text
Zed Agent Panel
    | ACP JSON-RPC over stdio
    v
dsh-acp-interactive
    | create/followup/cancel + session event projection
    v
dsh agent loop -> DeepSeek provider
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

## 后续阶段

第二阶段补齐持久会话的 `list/load/resume/close/delete`，模型和权限 config selector，plan/default mode，图片与 resource link，用户问题 elicitation，MCP server 接入以及 additional directories。之后再根据 Zed 实际兼容性决定是否使用不稳定 ACP 扩展。

## Zed 连接方式

构建后，在 Zed 的 settings 中登记一个自定义 agent server。Windows 示例：

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "type": "custom",
      "command": "pnpm.cmd",
      "args": [
        "--dir",
        "D:/variFlight_work/deepseek-harness",
        "run",
        "demo:acp:interactive"
      ]
    }
  }
}
```

发布包安装后，配置可以收敛成 `dsh-acp-interactive-demo --config <path>`。stdio 的 stdout 只承载 ACP 帧；诊断必须写 stderr。

## 第一阶段验收

1. Zed 能创建 session、提交文字任务并取消正在运行的任务。
2. 文字与思考在生成时分别流式出现，不等待最终消息。
3. 读文件、修改文件和 shell 命令使用工具声明的卡片、位置、diff 与终端内容展示。
4. dsh 的 ask 策略在 Zed 中出现审批控件，拒绝不会被解释成允许。
5. todo、标题、命令目录与上下文占用变化能刷新 Zed UI。
6. 多个 Zed session 之间不串流、不串审批、不互相取消。
7. 插件卸载或 stdio 断开时，所有由它创建的 agent 先停止并达到静止，再解除注册。
