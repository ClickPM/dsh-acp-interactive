# dsh-acp-interactive

[中文](README.md) | English

Editor-facing Agent Client Protocol server over JSON-RPC stdio. It creates dsh agents on demand and projects their live session events into ACP message, thought, tool, permission, plan, title, usage, and command updates. Zed is the first compatibility target.

This package publishes both the UI transport plugin and the `dsh-acp-interactive` executable. The transport contains no domain logic; the executable loads the complete Cordis composition shipped with the package, so ordinary users do not need a DeepSeek Harness source checkout. This UI bridge is separate from the upstream automation-only ACP transport.

## Installation

Before an npm release, install globally from GitHub and pin an audited commit:

```sh
npm install --global github:cking000bigdemon/dsh-acp-interactive#<sha>
```

GitHub installation runs this package's `prepare` build and installs the `dsh-acp-interactive` command. That command loads the reviewed editor profile bundled in `config/cordis.yml`, which composes DeepSeek and user providers, the agent spine, file and local filesystem-search capabilities, shell, permissions, persistence, human commands, and the ACP transport. At startup, Windows registers the native `pwsh` tool, while Linux and macOS register `bash`; the model never receives both tool dialects. Stdout carries JSON-RPC frames only.

Custom deployments may instead consume only the transport export and mount it in a dedicated ACP stdio composition:

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

The bundled composition explicitly mounts these three provider dependencies. `settings-file` reads `$DSH_HOME/settings.yaml` by default, `credentials-local` resolves managed credentials from the same dsh home, and the dormant `llm-pi-ai` mount dynamically registers every route under `llm-pi-ai.providers`. With no `DSH_HOME` override, the current user's default `.dsh` directory is used. Pi Agent Desktop and Zed ACP can therefore share provider profiles, model catalogs, and credential references without copying API keys into Zed or `cordis.yml`. A profile's `apiKeyEnv` must match a key under `.credentials.yaml` `refs`. The desktop app and ACP server remain separate processes with isolated sessions.

`provider` and `model` select only the initial route for a new session; they do not restrict the model selector. When the surrounding composition also retains the DeepSeek adapter, Zed groups DeepSeek together with the user's OpenAI-compatible, Anthropic, and custom gateway routes. Changes to `settings.yaml` refresh the provider directory through the existing settings and LLM-registry update path.

## Plugin

`apply(ctx, config)` requires `agents`, `commands`, `llm`, `skills`, `tools`, `sessionPersistence`, and `sessionQuery`. It answers approval requests only for agents it created and delegates every foreign request. One connection may own several isolated sessions; every event, selection, skill lookup, and approval is checked against the exact agent object before it reaches the wire. A composed `permissionPresets` service adds the permission selector; its absence leaves model selection available and omits permission configuration.

| Config | Meaning |
|---|---|
| `provider` | Optional provider route for newly created agents. |
| `model` | Optional model id for newly created agents. |

`stream` is a runtime-only test override. Production reserves stdout for ACP frames and reads frames from stdin.

## Protocol

The plugin implements `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/list`, `session/load`, `session/resume`, and `session/close`. Text and reasoning deltas stream immediately. Tool calls use each tool's `presentCall`, `presentResult`, and durable `presentationMeta`; generic, diff, and terminal intents map to ACP cards without switching on tool names. The editor profile's new `glob` and `grep` tools execute in the published Harness filesystem-search plugin with its packaged ripgrep binary and use the same generic projection. `todo/write`, `session/title`, request capacity, provider usage, and command-registry changes update the matching client session.

`session/list` reads the live-preferred query corpus in deterministic newest-created order, omits sessions without a recorded absolute cwd, supports exact cwd filtering, and includes log-backed titles when available. The current response is one complete page; a non-null cursor fails explicitly.

`session/load` restores the persisted dsh agent and replays assembled human and assistant messages, reasoning, images, tool cards, the latest plan and title, final usage, and the command catalog before returning. It never replays raw assistant chunks, so assembled messages appear once. `session/resume` restores the same context without emitting history. `session/close` cancels prompt admission, skill discovery, model, or command work, waits for output and continuable descendants to settle, and then disposes the exact owned agent.

The ACP command catalog merges the exact agent's `ctx.commands` view with the `userInvocable` skills discovered for its cwd and scope. A real command wins a same-name collision. `commands/change` and `skills/change` trigger full per-session replacement updates; incomplete or failed skill observations retain the last complete skill entries, and a complete empty result removes them. A leading `/<skill-name>` that still resolves to a user-invocable definition enters the ordinary user-message path, where `@deepseek-ai/dsh-tool-skill` performs the standard logged `agent/pre-step` injection. Unknown slash names remain unknown commands, and model-only skills are neither advertised nor accepted as explicit ACP skill invocations.

The catalog does not declare domain commands itself. The bundled editor profile composes `/permission`, `/plan`, `/compact`, `/goal`, and `/feedback` with their corresponding domains/providers, while discovery still comes only from actual `ctx.commands.register()` calls. This bridge executes registered commands and does not treat model tools as slash commands.

Text, resource-link, and inline raster-image prompts are supported. Resource links become explicit bracketed references in the durable user message. When an attachment store is composed, initialization advertises image input; each image is validated against the selected model route and stored before the message is queued, so the session log contains only durable references. Images replay as verified inline ACP content. Audio, embedded resources, MCP servers, and additional directories are rejected explicitly. Direct slash commands remain text-only.

When `ctx.planMode` is composed, new, loaded, and resumed sessions advertise `default` and `plan` modes. `session/set_mode` delegates to that service, and committed `plan/mode` events publish `current_mode_update`; the transport keeps no separate mode state.

When `ctx.userQuestions` is composed, the plugin registers a provider for its exact owned root agents. Clients advertising stable ACP form elicitation receive structured questions, choices, multi-select fields, optional free text, and plan-review detail. Decline or dismissal returns `ASK_CANCELLED`, turn or request cancellation returns `ASK_ABORTED`, unknown future actions fail closed, and clients without form elicitation fail explicitly.

## Session configuration

`session/new`, `session/load`, and `session/resume` return the complete ACP `configOptions` list. The model selector groups each adapter's advisory catalog by provider and encodes the complete provider/model route in each value. The selected route applies at the next prompt-assembly boundary; a step already assembling or running keeps its captured route. Restored sessions use the latest logged request header, and an unadvertised restored route remains a current-only row instead of being replaced by the composition default. Client values not present in the current directory are rejected.

Configuration projection accepts ACP 1.x's `model_config` category and gates boolean options on the client's `session.configOptions.boolean` capability. The current composition has no real boolean domain option, so it does not invent or advertise a toggle; unknown boolean configuration and malformed value types are rejected explicitly.

When the selected model advertises reasoning efforts, a `thought_level` selector exposes `Default` plus every adapter-owned effort. The selected value applies at the next prompt-assembly boundary. Switching models resets the explicit effort to the new route's default; restored sessions recover the effort from the latest request header, including a current-only historical value when its catalog row or all reasoning metadata is unavailable.

When `ctx.permissionPresets` is composed, a permission selector exposes its configured presets. A switch executes the existing `/permission` write path, so the preset, sandbox mode, approval policy, live approval state, and durable events stay aligned. A running session also accepts permission changes: the switch commits durable events immediately and takes effect on subsequent confined calls and approval requests. Configuration requests are serialized per session, and a prompt cannot pass an unsettled switch. Adapter topology changes, selector switches, and direct `/permission` commands publish a full `config_option_update`.

## Tool execution and permissions

ACP never executes a dsh tool. A tool call stays inside the harness and uses its normal cwd, sandbox, subprocess, timeout, and lifecycle policies. A bridge-owned `approval/request` becomes an ACP permission request with `allow_once` and `reject_once`; cancellation stays cancellation and an unknown option never grants access.

The Zed terminal extension is capability-gated. When the client advertises `_meta.terminal_output`, a terminal render intent produces terminal metadata and captured output. Other clients receive a fenced console fallback. File paths in locations and diffs stay unchanged so editor follow-along opens the operated file.

## Running with Zed

After installation, register the installed command directly in Zed. On Windows, `where.exe dsh-acp-interactive` prints its absolute path:

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

Zed starts the server with the workspace as cwd. JSONL sessions live under that workspace's `.sessions`, while every server process owns a separate in-memory SQLite session-query index. Multiple editor processes can share the JSONL source of truth without contending for the derived index. No DeepSeek Harness checkout or DeepSeek-specific Zed code is required.

See the [Zed compatibility matrix](docs/compatibility.en.md) for supported versions and verification status. This release uses the stable ACP v1 schema from SDK `1.4.0` as its baseline.

An explicitly configured image-capable model must declare its input modalities. For example:

```yaml
- id: deepseek-v4-flash-vision-exp
  inputModalities: [text, image]
```

Without this metadata, the DeepSeek adapter treats that explicit catalog entry as text-only and the bridge rejects image admission before queuing the prompt.

## Model Experience

### Prompts and commands

#### What the model sees

An ordinary ACP text prompt becomes one human `user/message` and enters the standard dsh request. A slash-leading prompt resolves a real `ctx.commands` entry first; otherwise an exact user-invocable skill remains a user message and receives the standard logged skill injection. Command discovery and direct output stay outside model history, while a command-owned domain mutation may affect later requests.

#### Token effect

Ordinary prompt text has the same retained token cost as any dsh human message. Direct command discovery, input, and output add no model tokens; a user-explicit skill adds its rendered instructions through the standard skill consumer, and a command-owned domain decides the cost of any later model-visible projection.

#### KV Cache effect

Ordinary prompt text appends after the reusable request prefix. Direct command traffic does not affect the cache; a skill injection changes that request's appended context, and a command-owned model-visible change follows that domain's cache behavior.

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
- Session cost is sent only after a Harness backend supplies a reliable cumulative amount and currency; the bridge does not estimate cost from token prices.
- MCP servers and additional directories are deferred.
- Terminal output is delivered at tool completion rather than incrementally.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
npm run check:profile
npm run verify:packed
```

The standalone repository has no runtime dependency on a DeepSeek Harness checkout. For development compatibility, set `DSH_HARNESS_ROOT` to a read-only official checkout or place one at the sibling `../deepseek-harness` path, then run `npm run test:harness`. The command copies the current official `packages/acp/acp-interactive/tests` into an ignored temporary directory and runs those assertions against this repository's `src`. `check:profile` reconciles official candidate packages, human commands, required providers, and critical consumers, reporting review-required drift without rewriting the release composition. `verify:packed` installs the tarball outside the repository and starts the real ACP launcher. `npm run test:all` chains repository tests, official compatibility tests, and profile reconciliation.

See the [design document](docs/design.md) for the implemented scope and the [development roadmap](docs/roadmap.en.md) for the recommended sequence and acceptance criteria.

## License

[MIT](LICENSE)
