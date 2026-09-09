# Zed 兼容矩阵

[中文](compatibility.md) | [English](compatibility.en.md)

本矩阵对应 `deepseekharness-acp-interactive 1.1.0`、稳定 ACP v1 和 `@agentclientprotocol/sdk 1.4.0`。版本结论以 Zed 发布说明、当前 Zed ACP client 能力声明，以及本仓库真实 NDJSON launcher/连接测试为依据。

| Zed 版本 | 状态 | 能力范围 |
| --- | --- | --- |
| `1.16.x` | 推荐；本机检测 `1.16.3` | message ID、request cancellation、usage、稳定 form elicitation、select/boolean config capability 和 session lifecycle 全部按 ACP v1 协商。 |
| `1.12.x`–`1.15.x` | 支持的最低完整阶段 A 范围 | `1.12.0` 起稳定 elicitation 默认启用；session config 与 boolean toggle 已进入稳定版。建议升级到最新补丁版本。 |
| `0.223.x`–`1.11.x` | 兼容但功能不完整 | 基础 ACP 和 select config 可用；较旧版本可能不声明稳定 elicitation 或 boolean config，插件会隐藏相应可选能力，不做宽松降级。 |
| `< 0.223` | 不支持 | 缺少本插件依赖的完整 session config UI 基线。 |

## 验证范围

- 初始化公布已组合的 `loadSession`、list/resume/close、prompt 模态和 MCP HTTP capability；stdio MCP 是稳定 v1 基线。SSE、ACP transport、delete 和 additional directories 不公布或明确拒绝。
- 真实 MCP 测试覆盖 stdio/HTTP 映射、工具发现与调用、同名跨 session 隔离、new/load/resume、取消、失败回滚、连接 teardown 和子进程退出。
- SDK schema conformance 测试覆盖 message ID、`usage_update`/cost 字段、`model_config`、boolean set 请求、稳定 elicitation extensible union 和 `$/cancel_request`。
- request cancellation 测试通过真实 NDJSON 连接取消一个长 prompt，验证另一个 session 不受影响，两个 session 随后都可继续使用。
- Session 生命周期测试通过两个同时启动、共享 JSONL 真源且各自持有内存 SQLite 派生索引的真实 launcher，验证 close 后可立即跨进程 list/load/resume，且重复 close/restore 不删除历史。
- 当前没有真实 boolean 领域配置，因此即使 Zed 声明支持也不会显示虚构开关。cost 同样只在 Harness 提供可信累计金额时发送。

## 固定上游基线

组合的 Harness 包固定在 `0.1.2-rc.1`，`config/upstream-baseline.json` 记录对应的官方 git ref `dsh-v0.1.2-rc.1`，`npm run test:harness` 从该 ref 提取 spec。

在该版本，官方 `@deepseek-ai/dsh-acp` transport 向本服务器的设计大幅收敛：新增了 `session/list`、`session/resume`、`session/close`、`session/set_config_option`、按会话组合 MCP 和 `usage_update`。但它仍是 automation-only transport，因此本面向编辑器的服务器仍然公布严格更多的能力：`session/load`、slash 命令与 skill、带 diff 和终端内容的工具自有展示卡片、form elicitation、权限配置和终端认证。

这个差异决定了只有 `config/upstream-baseline.json` 中标记为 aligned 的 spec 会原样运行。其余逐个记录为两类显式分歧：

- `composition` — 官方 `tests/harness.ts` 未组合 `commands`、`skills`、`sessionQuery`，而本服务器为了提供 slash 命令、skill 和 `session/load` 对这三个服务声明了 inject。在该 harness 下本插件 fiber 永不激活，因此这些 spec 无法在此执行；每一项都由本仓库自有的对应套件覆盖。
- `internal-api` — spec 引用官方私有模块名，或 `0.1.2-rc.1` 重构新引入的模块（`src/model-control.ts`、`src/updates.ts`）。对应的协议行为在本仓库以自有的模块划分存在。

记录分歧是经过评审的结论，而不是跳过：当固定 ref 新增、移除或重命名 spec 时门会失败，且禁止为了保持绿色而重新分类。

Zed 的稳定版发布记录见其[发布页](https://zed.dev/releases/stable)，当前 ACP client 的能力声明见 [Zed ACP 实现](https://github.com/zed-industries/zed/blob/main/crates/agent_servers/src/acp.rs)。
