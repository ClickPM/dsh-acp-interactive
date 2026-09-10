# 更新日志

[dsh-acp-interactive](README.zh.md) 的版本说明。English: [CHANGELOG.md](CHANGELOG.md).

## 1.3.0

`1.3.0` 加入进程内 subagent。组合 profile 现在装配已发布的 `@deepseek-ai/dsh-subagent` 注册表、`spawn` 与 `fork` 两个 backend，以及 `subagent`、`subagent_fork` 两个委托工具：模型把一个独立任务或需要沿用本对话的任务委托出去，并以工具结果收到子 agent 的最终回答，语义与上游完全一致。在 Zed 中，一次委托就是一张工具卡片：子 agent 发布后卡片以委托的 description 作为标题，运行期间子 agent 自己的工具调用、回复、嵌套委托与结算折叠为卡片内有界的 transcript，父 agent 自己的工具结果结算卡片，transcript 保留在结果之前。卡片的 `_meta.dsh_subagent` 记录子 session id，可据此在 sessions 根目录下找到它的日志。

每次委托都在父 turn 内前台等待，因此 `session/cancel`、`session/close` 与连接拆卸都会先停掉子 agent，父 agent 才报告空闲；被取消的委托以失败卡片结算，transcript 以 `Subagent aborted` 结尾，调用结算后不再有任何子事件到达卡片。子 agent 继承父 session 的 sandbox mode，approval 固定为 `never`，并移除 `ask_user_question`，因此子 agent 不会发起 ACP permission request 或提问；升级路径仍归父 agent。子 session 不是编辑器会话：`session/list` 不列出它们，`session/load` 与 `session/resume` 明确拒绝。后台 job、continuable child 与进程外 backend 继续暂缓。见 [In-Process Subagents Agent Note](docs/agent-notes/2026-09-10-in-process-subagents.md)。

## 1.2.0

`1.2.0` 将组合的 DeepSeek Harness 基线从 `0.1.2-rc.1` 移到 `0.1.5-rc.1`，公布的 ACP 能力面不变：ACP SDK 仍固定在 `1.4.0`，`initialize` 的应答与之前完全一致。

上游的 session 格式现为 v3：每次模型 attempt 的 provider 流内嵌进一条耐久结算事件，不再写逐 token 事件，因此实时的文本与推理增量改由 harness 进程内的 `agent/assistant-stream` frame 送达编辑器，而组装后的消息仍是重放来源；实时输出与 `session/load` 之间的 message id 不变。仅存日志的失败或重试 attempt 永远不会作为消息展示。`1.1.0` 及更早版本写下的 session 在首次读取时迁移为同目录的 `session.v3.jsonl.zstd`，原文件保持不动，因此 `session/list` 与 `session/load` 继续可用，回滚后仍读取旧文件。profile 的系统提示 persona 跟进了上游的改名（`persona` → `personaPrefix`），否则会被静默丢弃；`check:profile` 的官方参照文件在 `0.1.2-rc.1` 之前就已搬走，现已修复并记录了由此产生的差异。见 [Upstream 0.1.5-rc.1 Baseline Agent Note](docs/agent-notes/2026-09-10-upstream-0.1.5-rc.1-baseline.md)。

## 1.1.0

`1.1.0` 将组合的 DeepSeek Harness 基线从 `0.1.1-rc.2` 移到 `0.1.2-rc.1`，公布的 ACP 能力面不变。

上游删除了本部署原本以单行挂载的 `@deepseek-ai/dsh-agent-spine-demo` 示例包，改为由 launcher 在运行时解析的 bundle patch 分层。本版本不采用该机制，而是保持 `config/cordis.yml` 为单一、扁平、完全可审计的组合：原 bundle 的子插件现为 25 条显式插件行，集合与配置保持一致，使发行组合仍可与评审清单逐项比对。适配该版本同时需要跟进三项上游契约变更：`Session.snapshotEvents()` 取代被移除的 `events` 读面、权限预设改为通过 session projection 注册表读取状态、用户提问从 provider 注册改为按作用域过滤的 answerer waterfall。

官方兼容测试门已修复并界定范围。它原先复制的测试路径在任何上游版本都不存在，因此一直在报 `fixture unavailable` 而从未真正运行，且会读取本地 checkout 恰好处于的任意版本；现在改为按 `config/upstream-baseline.json` 记录的固定 git ref 提取官方 spec。由于 `0.1.2-rc.1` 向本服务器的设计收敛但仍为 automation-only——仍未实现 `session/load`、slash 命令、skill、展示卡片和 elicitation——只有标记为 aligned 的 spec 会原样运行，其余官方 spec 逐个记录为附理由的显式分歧。当固定 ref 新增、移除或重命名 spec 时该门失败，使下一个上游版本进入评审而不是被静默跳过。参见 [Zed 兼容矩阵](docs/compatibility.md) 和 [Upstream 0.1.2-rc.1 Baseline Agent Note](docs/agent-notes/2026-09-09-upstream-0.1.2-rc.1-baseline.md)。

## 1.0.9

`1.0.9` 让当前 route 为 DeepSeek 官方 provider 的 `session/prompt` 在 `DEEPSEEK_API_KEY` 未配置时返回 `auth_required`，不论模型目录里是否还有其他 provider。`1.0.7` 特意不再在多 provider 部署上拦 `session/new`，让这类用户能先开会话再切换路由，但此后在 DeepSeek 路由上提问会以内部模型调用错误失败；Zed 等客户端对来自 `session/prompt` 的 `auth_required` 同样会展示认证操作。直接的斜杠命令不经过模型，不做门控。

## 1.0.8

`1.0.8` 让 `Configure DeepSeek API key` 操作在 Zed 里真正拉起 `--setup`。Zed 的稳定版只通过方法上旧的 `_meta["terminal-auth"]` 对象执行终端认证（对稳定 `type: "terminal"` 方法的处理在 beta 标志之后），且该对象必须自带可执行文件；方法现在携带它，指向运行本服务的 Node 可执行文件和本包自己的 `bin.js --setup`——全局安装、Registry 的 `npx` 安装、源码检出都成立，服务以 `DSH_HOME` 启动时会转发该变量。`session/new` 在回答 `auth_required` 前还会持续一秒重读未配置的 key，因为 Zed 在 setup 终端退出的瞬间就重试，而凭据 provider 的 watcher 要在写入后约 100 ms 才加载到。launcher 现在还会在客户端关闭其 stdin 后自行退出；此前组合中的文件 watcher 会让进程一直活到收到信号为止。

## 1.0.7

`1.0.7` 把 `auth_required` 门控收窄到模型目录里只有 DeepSeek 官方 provider 的部署。`settings.yaml` 里加了 `llm-pi-ai` 路由的用户在没有 DeepSeek key 时不再被挡在 session 之外，可以先开会话再切换到那些路由；缺少 DeepSeek key 只在真正使用 DeepSeek 路由时才报错。全新安装仍会在第一次提问前看到 `Configure DeepSeek API key` 操作。

## 1.0.6

`1.0.6` 让 `session/new` 在组合默认 route 为 DeepSeek 官方 provider 且 `DEEPSEEK_API_KEY` 未配置时返回 ACP 的 `auth_required` 错误。客户端只在收到该错误时才渲染 `authMethods`，所以 `1.0.5` 始终公布的方法在 Zed 里直到第一次提问失败前仍然不可见；现在没有 key 时新开线程就会出现 `Configure DeepSeek API key` 操作，`--setup` 存入的 key 会被下一次 `session/new` 直接采用。检查只用凭据存储的 `describe()`（仅"已配置"状态，不读值），且只作用于 DeepSeek 默认 route。见 [Auth Method Fallback and Registry Id Agent Note](docs/agent-notes/2026-09-09-auth-method-fallback-and-registry-id.md)。

## 1.0.5

`1.0.5` 始终公布 `deepseek-api-key` 认证方法：客户端声明 terminal authentication 时为 `terminal` 类型，否则为 agent 类型方法，其描述指向 `--setup` 与 `DEEPSEEK_API_KEY`，因此未声明该能力的客户端（例如 JetBrains IDE，其 `initialize` 不带 terminal-auth 标志）看到的是配置说明而不是空列表。`agentInfo` 改为从 `package.json` 读取包版本，`agentInfo.name` 与 ACP Registry id `dsh-acp-interactive` 一致；Registry 条目也改用该 id，并在描述中声明社区维护、非官方的身份。见 [Auth Method Fallback and Registry Id Agent Note](docs/agent-notes/2026-09-09-auth-method-fallback-and-registry-id.md)。

## 1.0.4

`1.0.4` 把英文 README 设为 GitHub 与 npm 的默认文档（中文版见 [README.zh.md](README.zh.md)），新增公开的跨平台 CI、由 tag 驱动并使用 npm trusted publishing 的发布流程，并把 ACP Registry 条目（`registry/agent.json` 与 `icon.svg`）保存在本仓库，由 Registry 自己的校验脚本每日复查。详见[验证与 ACP Registry](README.zh.md#验证与-acp-registry)。测试套件与 packed-install 校验脚本现在在 Linux 和 macOS 上也能通过，修改仅限测试夹具与校验脚本。运行时行为与 `1.0.3` 一致：terminal authentication 同时识别稳定 ACP v1 能力字段和 ACP Registry validator 的旧 `_meta["terminal-auth"]` 兼容字段；支持该能力的客户端通过独立的 `--setup` 进程配置 DeepSeek 官方 API key，普通 ACP transport 不接触或输出密钥。
