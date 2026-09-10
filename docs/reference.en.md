# Behavior reference

Detailed behavior of the ACP surface implemented by [dsh-acp-interactive](../README.md): the plugin contract, authentication, per-method semantics, session configuration, tool execution, and what each surface costs the model. 中文版见 [reference.md](reference.md).

## Plugin

`apply(ctx, config)` requires `agents`, `commands`, `llm`, `skills`, `tools`, `sessions`, `sessionPersistence`, and `sessionQuery`. It answers approval requests only for agents it created and delegates every foreign request. One connection may own several isolated sessions; every event, selection, skill lookup, and approval is checked against the exact agent object before it reaches the wire. A composed `permissionPresets` service adds the permission selector; its absence leaves model selection available and omits permission configuration.

| Config | Meaning |
|---|---|
| `provider` | Optional provider route for newly created agents. |
| `model` | Optional model id for newly created agents. |

`stream` is a runtime-only test override. Production reserves stdout for ACP frames and reads frames from stdin.
## Authentication and credentials

Before using the official DeepSeek API for the first time, run:

```sh
dsh-acp-interactive --setup
```

The prompt does not echo the API key. It delegates an atomic
`DEEPSEEK_API_KEY` write in `$DSH_HOME/.credentials.yaml` to the Harness
credentials service, whose provider owns locking, concurrent updates, and the
POSIX `0700` directory / `0600` file permissions. Leaving the prompt blank
keeps an existing file credential. When the launching environment already
supplies `DEEPSEEK_API_KEY`, that value wins by Harness precedence and setup
does not write a shadowed file credential. Setup only stores the credential;
it makes no network request, so the first model request still validates the
key.

`initialize` always advertises one `deepseek-api-key` authentication method.
Clients that declare ACP terminal authentication (stable
`clientCapabilities.auth.terminal` or the legacy `_meta["terminal-auth"]`
flag) receive it as a `terminal` method that opens the same interactive
`--setup` flow; for Zed, whose stable releases act only on the legacy
`_meta["terminal-auth"]` object, the method also carries that object,
naming the Node executable running the server and this package's `bin.js`. Clients without that capability receive it as a plain
agent-type method whose description points at `dsh-acp-interactive --setup`
and `DEEPSEEK_API_KEY`; `authenticate` then succeeds immediately, because
credentials are resolved by the Harness credential store at the first model
request rather than by the transport. The terminal setup runs as a separate
process and does not start the ACP transport; normal server mode continues to
reserve stdout for JSON-RPC frames.

`session/new` returns the ACP `auth_required` error while the composition's
default route is the official DeepSeek provider and `DEEPSEEK_API_KEY` is not
configured, so clients such as Zed show the method before the first prompt
instead of failing at the first model request. The check reads only the
credential's configured state, never its value, and a key stored by `--setup`
is seen by the next `session/new` without a restart. Deployments that select
another default provider are not gated, and neither is a model directory that
offers other providers (for example `llm-pi-ai` routes from `settings.yaml`):
such a user may hold credentials for those routes and switch to them. A
`session/prompt` whose current route is the official DeepSeek provider is
checked the same way regardless, so a missing DeepSeek key surfaces as
`auth_required` — and the client's authentication action — rather than as a
model-call error; direct slash commands are not gated.
## Protocol

The plugin implements `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/list`, `session/load`, `session/resume`, and `session/close`. Text and reasoning deltas stream immediately. Tool calls use each tool's `presentCall`, `presentResult`, and durable `presentationMeta`; generic, diff, and terminal intents map to ACP cards without switching on tool names. The editor profile's new `glob` and `grep` tools execute in the published Harness filesystem-search plugin with its packaged ripgrep binary and use the same generic projection. A delegation through the `subagent` or `subagent_fork` tool is one card of the same kind: the child's events fold into the card as a bounded transcript, and the parent's tool result settles it. `todo/write`, `session/title`, request capacity, provider usage, and command-registry changes update the matching client session.

After a new session receives its first eligible text prompt, Harness publishes its immediate deterministic fallback title and then asynchronously summarizes that prompt with the exact provider/model route recorded for the main request. The accepted model result is persisted as a newer `session/title` event and replaces the client title through `session_info_update`. Failure, timeout, or framed input beyond 4096 bytes keeps the fallback without delaying the main agent response. Later prompts do not repeatedly retitle the session.

`session/list` reads the live-preferred query corpus in deterministic newest-created order, omits sessions without a recorded absolute cwd, supports exact cwd filtering, and includes log-backed titles when available. The current response is one complete page; a non-null cursor fails explicitly.

`session/load` restores the persisted dsh agent and replays assembled human and assistant messages, reasoning, images, tool cards, the latest plan and title, final usage, and the command catalog before returning. It never replays raw assistant chunks, so assembled messages appear once. `session/resume` restores the same context without emitting history. `session/close` cancels prompt admission, skill discovery, model, or command work, waits for output and continuable descendants to settle, crosses the standard `ctx.sessions.flush()` durability barrier, and only then disposes the exact owned agent. After a successful response, another process sharing the JSONL source can discover and restore the history immediately. A checkpoint failure still releases live resources and fails explicitly; close never deletes durable history.

MCP configuration is live, complete, and session-scoped. Stdio commands are passed directly as executable plus argv without shell interpolation; explicit env values and HTTP headers are never persisted in the session log or added to model context. Stable ACP v1 stdio and HTTP transports are supported, while SSE, ACP-proxied MCP, and unknown variants fail explicitly. Initial connection or tool-discovery failure fails the whole create/restore transaction and rolls back every server already started. Load and resume use only the current request's complete configuration, so an omitted, removed, changed, or failed server never inherits an older connection. Deterministic `mcp__<server>__<tool>` names remain stable across restoration, while private per-session Cordis roots permit two sessions to use the same server name without sharing tools.

A personal control plane may live on the client side, but it is not a runtime dependency of this package. For example, Zed `context_servers` may configure each service as `agent-config-mcp serve <service-id>` and pass it here through standard ACP `mcpServers`; this package still consumes only protocol records and never reads a personal directory or recognizes that command. A standalone Harness WebUI may use its own agent-config consumer only when it creates separate connections in a private Cordis root for every agent, and that consumer must not be added to this package's `config/cordis.yml`. Zed ACP and the `npx dsh` WebUI can therefore share static definitions and credential references without sharing an MCP Client, transport, tool registry, session ID, cancellation signal, child process, or reconnect task. See the [Agent Note](agent-notes/2026-09-07-agent-config-integration.md) for the full boundary.

The ACP command catalog merges the exact agent's `ctx.commands` view with the `userInvocable` skills discovered for its cwd and scope. A real command wins a same-name collision. `commands/change` and `skills/change` trigger full per-session replacement updates; incomplete or failed skill observations retain the last complete skill entries, and a complete empty result removes them. A leading `/<skill-name>` that still resolves to a user-invocable definition enters the ordinary user-message path, where `@deepseek-ai/dsh-tool-skill` performs the standard logged `agent/pre-step` injection. Unknown slash names remain unknown commands, and model-only skills are neither advertised nor accepted as explicit ACP skill invocations.

The catalog does not declare domain commands itself. The bundled editor profile composes `/permission`, `/plan`, `/compact`, `/goal`, and `/feedback` with their corresponding domains/providers, while discovery still comes only from actual `ctx.commands.register()` calls. This bridge executes registered commands and does not treat model tools as slash commands.

Text, resource-link, and inline raster-image prompts are supported. Resource links become explicit bracketed references in the durable user message. When an attachment store is composed, initialization advertises image input; each image is validated against the selected model route and stored before the message is queued, so the session log contains only durable references. Images replay as verified inline ACP content. Audio, embedded resources, and additional directories are rejected explicitly; the independent `dsh-additional-directories` DSH plugin project owns the Additional directories domain capability. Direct slash commands remain text-only.

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

A subagent card is client-only as well. The child transcript folded into the parent's card never enters either model's context; the parent sees only the child's final output through the ordinary tool-result path, and the child sees only its delegated prompt plus the standard delegated-runtime context the harness appends.

#### Token effect

The ACP updates add no model tokens. Tool results retain their ordinary dsh model-facing cost. A delegation runs the child's own requests on the inherited or configured route; the parent pays for the tool call and the child's final output only.

Model-generated titles use a separate auxiliary request. It reads only the first eligible human message, emits at most 32 tokens, and incurs the selected route's ordinary usage; neither the generated title nor its framing enters the main agent history.

#### KV Cache effect

The UI projection does not affect reuse. A tool result appends through the standard session surface and has that path's ordinary cache effect.

### Model, reasoning, mode, and permission controls

#### What the model sees

Selector and mode metadata are client-only. Model and reasoning selections change the route fields logged by the next assembled request. Plan mode changes the standard plan guidance and exit tool behavior through `ctx.planMode`. A permission selection changes later tool execution and any standard permission narration owned by the sandbox and approval plugins.

#### Token effect

The controls add no model tokens themselves. A selected route and effort have that model's ordinary token behavior; plan mode adds its configured guidance; a permission preset has only the token effect of its existing policy projection.

#### KV Cache effect

Changing provider or model starts using that route's cache identity on the next request. Changing reasoning effort or plan guidance changes the request and therefore its reusable prefix. Permission selection follows the existing sandbox/approval projection behavior and does not add ACP traffic to the prompt.
