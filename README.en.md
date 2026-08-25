# dsh-acp-interactive

[中文](README.md) | English

Editor-facing Agent Client Protocol server over JSON-RPC stdio. It creates dsh agents on demand and projects their live session events into ACP message, thought, tool, permission, plan, title, usage, and command updates. Zed is the first compatibility target.

This package is a UI transport plugin. The agent loop, model provider, tools, sandbox, subprocesses, and approval policy remain in the surrounding Cordis composition. This UI bridge is separate from the upstream automation-only ACP transport.

## Installation

Before an npm release, install directly from GitHub and pin an audited commit:

```sh
npm install github:cking000bigdemon/dsh-acp-interactive#<sha>
```

GitHub installation runs this package's `prepare` build. Put the plugin in a dedicated ACP stdio composition, not an ordinary console profile, because stdout carries JSON-RPC frames only:

```yaml
- id: acp-interactive
  name: 'dsh-acp-interactive'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
```

## Plugin

`apply(ctx, config)` requires `agents`, `commands`, `llm`, `tools`, `sessionPersistence`, and `sessionQuery`. It answers approval requests only for agents it created and delegates every foreign request. One connection may own several isolated sessions; every event, selection, and approval is checked against the exact agent object before it reaches the wire. A composed `permissionPresets` service adds the permission selector; its absence leaves model selection available and omits permission configuration.

| Config | Meaning |
|---|---|
| `provider` | Optional provider route for newly created agents. |
| `model` | Optional model id for newly created agents. |

`stream` is a runtime-only test override. Production reserves stdout for ACP frames and reads frames from stdin.

## Protocol

The plugin implements `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/list`, `session/load`, `session/resume`, and `session/close`. Text and reasoning deltas stream immediately. Tool calls use each tool's `presentCall` and `presentResult` methods; generic, diff, and terminal intents map to ACP cards without switching on tool names. `todo/write`, `session/title`, request capacity, provider usage, and command-registry changes update the matching client session.

`session/list` reads the live-preferred query corpus in deterministic newest-created order, omits sessions without a recorded absolute cwd, supports exact cwd filtering, and includes log-backed titles when available. The current response is one complete page; a non-null cursor fails explicitly.

`session/load` restores the persisted dsh agent and replays assembled human and assistant messages, reasoning, images, tool cards, the latest plan and title, final usage, and the command catalog before returning. It never replays raw assistant chunks, so assembled messages appear once. `session/resume` restores the same context without emitting history. `session/close` cancels prompt admission, model, or command work, waits for output and continuable descendants to settle, and then disposes the exact owned agent.

Text, resource-link, and inline raster-image prompts are supported. Resource links become explicit bracketed references in the durable user message. When an attachment store is composed, initialization advertises image input; each image is validated against the selected model route and stored before the message is queued, so the session log contains only durable references. Images replay as verified inline ACP content. Audio, embedded resources, MCP servers, and additional directories are rejected explicitly. Direct slash commands remain text-only.

When `ctx.planMode` is composed, new, loaded, and resumed sessions advertise `default` and `plan` modes. `session/set_mode` delegates to that service, and committed `plan/mode` events publish `current_mode_update`; the transport keeps no separate mode state.

When `ctx.userQuestions` is composed, the plugin registers a provider for its exact owned root agents. Clients advertising unstable ACP form elicitation receive structured questions, choices, multi-select fields, optional free text, and plan-review detail. Decline or dismissal returns `ASK_CANCELLED`, turn cancellation returns `ASK_ABORTED`, and clients without form elicitation fail explicitly.

## Session configuration

`session/new`, `session/load`, and `session/resume` return the complete ACP `configOptions` list. The model selector groups each adapter's advisory catalog by provider and encodes the complete provider/model route in each value. The selected route applies at the next prompt-assembly boundary; a step already assembling or running keeps its captured route. Restored sessions use the latest logged request header, and an unadvertised restored route remains a current-only row instead of being replaced by the composition default. Client values not present in the current directory are rejected.

When the selected model advertises reasoning efforts, a `thought_level` selector exposes `Default` plus every adapter-owned effort. The selected value applies at the next prompt-assembly boundary. Switching models resets the explicit effort to the new route's default; restored sessions recover the effort from the latest request header, including a current-only historical value when its catalog row or all reasoning metadata is unavailable.

When `ctx.permissionPresets` is composed, a permission selector exposes its configured presets. A switch executes the existing `/permission` write path, so the preset, sandbox mode, approval policy, live approval state, and durable events stay aligned. A running session refuses permission changes. Configuration requests are serialized per session, and a prompt cannot pass an unsettled switch. Adapter topology changes and direct `/permission` commands publish a full `config_option_update`.

## Tool execution and permissions

ACP never executes a dsh tool. A tool call stays inside the harness and uses its normal cwd, sandbox, subprocess, timeout, and lifecycle policies. A bridge-owned `approval/request` becomes an ACP permission request with `allow_once` and `reject_once`; cancellation stays cancellation and an unknown option never grants access.

The Zed terminal extension is capability-gated. When the client advertises `_meta.terminal_output`, a terminal render intent produces terminal metadata and captured output. Other clients receive a fenced console fallback. File paths in locations and diffs stay unchanged so editor follow-along opens the operated file.

## Running with Zed

The verified source launch uses the DeepSeek Harness checkout and its `examples/acp-interactive-agent/cordis.yml` composition. From that checkout, `pnpm run demo:acp:interactive` boots the server. The example stores JSONL sessions under `./.sessions`, uses one disposable in-memory SQLite session-query index per server process, checkpoints durable work before effects, and composes the standard workspace-write/full-access permission presets. Multiple editor server processes may share the JSONL root without sharing the single-owner derived index. Register that command in Zed:

```json
{
  "agent_servers": {
    "DeepSeek Harness": {
      "type": "custom",
      "command": "pnpm.cmd",
      "args": ["--dir", "D:/path/to/deepseek-harness", "run", "demo:acp:interactive"]
    }
  }
}
```

No DeepSeek-specific Zed code is required. The editor only needs support for custom ACP agent servers; Registry packaging and future protocol extensions may still benefit from upstream integration.

An explicitly configured image-capable model must declare its input modalities. For example:

```yaml
- id: deepseek-v4-flash-vision-exp
  inputModalities: [text, image]
```

Without this metadata, the DeepSeek adapter treats that explicit catalog entry as text-only and the bridge rejects image admission before queuing the prompt.

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

### Model, reasoning, mode, and permission controls

#### What the model sees

Selector and mode metadata are client-only. Model and reasoning selections change the route fields logged by the next assembled request. Plan mode changes the standard plan guidance and exit tool behavior through `ctx.planMode`. A permission selection changes later tool execution and any standard permission narration owned by the sandbox and approval plugins.

#### Token effect

The controls add no model tokens themselves. A selected route and effort have that model's ordinary token behavior; plan mode adds its configured guidance; a permission preset has only the token effect of its existing policy projection.

#### KV Cache effect

Changing provider or model starts using that route's cache identity on the next request. Changing reasoning effort or plan guidance changes the request and therefore its reusable prefix. Permission selection follows the existing sandbox/approval projection behavior and does not add ACP traffic to the prompt.

## Known Limitations and Deferred Work

- `session/delete` is not advertised. The persistence Service Definition has no backend-independent deletion method; direct JSONL or SQLite manipulation in this transport would bypass persistence ownership and reconciliation.
- `session/list` returns one complete page and omits `updatedAt`; a stable metadata cursor and cheap last-activity observation belong in the session-query capability.
- Audio and embedded-resource prompt blocks fail instead of degrading silently. Tool-result image cards remain text-only even though prompt and message-history images are supported.
- ACP form elicitation is unstable protocol and is available only when the client advertises it.
- MCP servers and additional directories are deferred.
- Terminal output is delivered at tool completion rather than incrementally.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

See the [design document](docs/design.md) for the phased scope.

## License

[MIT](LICENSE)
