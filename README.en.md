# dsh-acp-interactive

[中文](README.md) | English

Editor-facing Agent Client Protocol server over JSON-RPC stdio. It creates dsh agents on demand and projects their live session events into ACP message, thought, tool, permission, plan, title, usage, and command updates. Zed is the first compatibility target.

This package is a UI transport plugin. The agent loop, model provider, tools, sandbox, subprocesses, and approval policy remain in the surrounding Cordis composition. This UI bridge is separate from the upstream automation-only ACP transport.

## Plugin

`apply(ctx, config)` requires `agents`, `commands`, `tools`, `sessionPersistence`, and `sessionQuery`. It answers approval requests only for agents it created and delegates every foreign request. One connection may own several isolated sessions; every event and approval is checked against the exact agent object before it reaches the wire.

| Config | Meaning |
|---|---|
| `provider` | Optional provider route for newly created agents. |
| `model` | Optional model id for newly created agents. |

`stream` is a runtime-only test override. Production reserves stdout for ACP frames and reads frames from stdin.

## Protocol

The plugin implements `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/list`, `session/load`, `session/resume`, and `session/close`. Text and reasoning deltas stream immediately. Tool calls use each tool's `presentCall` and `presentResult` methods; generic, diff, and terminal intents map to ACP cards without switching on tool names. `todo/write`, `session/title`, request capacity, provider usage, and command-registry changes update the matching client session.

`session/list` reads the live-preferred query corpus in deterministic newest-created order, omits sessions without a recorded absolute cwd, supports exact cwd filtering, and includes log-backed titles when available. The current response is one complete page; a non-null cursor fails explicitly.

`session/load` restores the persisted dsh agent and replays assembled human and assistant messages, reasoning, tool cards, the latest plan and title, final usage, and the command catalog before returning. It never replays raw assistant chunks, so assembled messages appear once. `session/resume` restores the same context without emitting history. `session/close` cancels in-flight model or command work, waits for output and continuable descendants to settle, and then disposes the exact owned agent.

Text prompts and direct slash commands are supported. Images, resource links, audio, embedded resources, MCP servers, and additional directories are rejected explicitly. Restored history containing rich human, assistant, or tool-result blocks also fails instead of dropping content. Model/config selectors, modes, and elicitation remain later phases.

## Tool execution and permissions

ACP never executes a dsh tool. A tool call stays inside the harness and uses its normal cwd, sandbox, subprocess, timeout, and lifecycle policies. A bridge-owned `approval/request` becomes an ACP permission request with `allow_once` and `reject_once`; cancellation stays cancellation and an unknown option never grants access.

The Zed terminal extension is capability-gated. When the client advertises `_meta.terminal_output`, a terminal render intent produces terminal metadata and captured output. Other clients receive a fenced console fallback. File paths in locations and diffs stay unchanged so editor follow-along opens the operated file.

## Connecting Zed

This repository publishes the bridge as the Cordis entry `dsh-acp-interactive`. Put that entry in a dedicated ACP composition with session-persistence and session-query providers; do not add it to an ordinary console profile because stdout carries JSON-RPC frames only.

The currently verified Windows launch uses the DeepSeek Harness source checkout and its interactive ACP example. In Zed, open `Settings > AI > General > External Agents > Add Custom Agent` and fill the form:

| Field | Value |
|---|---|
| Agent Name | `DeepSeek Harness` |
| Command | `C:\\Program Files\\nodejs\\node.exe` |
| Arguments | `--import=file:///D:/variFlight_work/deepseek-harness/node_modules/tsx/dist/loader.mjs D:/variFlight_work/deepseek-harness/packages/examples/acp-demo/src/bin.ts --config D:/variFlight_work/deepseek-harness/examples/acp-interactive-agent/cordis.yml` |
| Environment Variables | `DEEPSEEK_API_KEY` with your key as the value |

The command and all arguments go into their separate Zed form fields exactly as shown. This package contains the plugin, not a standalone ACP launcher; the verified command above still boots the harness source composition. A composition consuming this repository selects the plugin with:

```yaml
- id: acp-interactive
  name: 'dsh-acp-interactive'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
```

No DeepSeek-specific Zed code is required. Zed only needs custom ACP agent support. Official integration is useful for Registry distribution and future extensions, but is not required for this connection.

## Model Experience

### Prompts and commands

#### What the model sees

An ordinary ACP text prompt becomes one human `user/message` and enters the standard dsh request. A slash-leading prompt resolves through `ctx.commands`; command discovery and direct output stay outside model history, while a command-owned domain mutation may affect later requests.

#### Token effect

Ordinary prompt text has the same retained token cost as any dsh human message. Direct command discovery, input, and output add no model tokens; a command-owned domain decides the cost of any later model-visible projection.

#### KV Cache effect

Ordinary prompt text appends after the reusable request prefix. Direct command traffic does not affect the cache; a command-owned model-visible change follows that domain's cache behavior.

### UI projections

#### What the model sees

Message, thought, tool-card, permission, plan, title, usage, and command updates are client-only. They add no tokens and do not change KV-cache reuse. Tool results and human permission decisions affect the model only through the ordinary dsh tool-result path.

#### Token effect

The ACP updates add no model tokens. Tool results retain their ordinary dsh model-facing cost.

#### KV Cache effect

The UI projection does not affect reuse. A tool result appends through the standard session surface and has that path's ordinary cache effect.

## Known Limitations and Deferred Work

- `session/delete` is not advertised. The persistence Service Definition has no backend-independent deletion method; direct JSONL or SQLite manipulation in this transport would bypass persistence ownership and reconciliation.
- `session/list` returns one complete page and omits `updatedAt`; a stable metadata cursor and cheap last-activity observation belong in the session-query capability.
- Prompt input is text-only; richer ACP blocks fail instead of degrading silently.
- Config selectors, collaboration modes, user-question elicitation, MCP servers, and additional directories are deferred.
- Terminal output is delivered at tool completion rather than incrementally.
