# Agent Note: stable ACP v1 baseline

## Decision

Release `0.6.0` pins `@agentclientprotocol/sdk 1.4.0` and migrates the production transport from deprecated connection classes to the typed `agent()` app API. Every request handler receives the SDK-owned `AbortSignal`; `$/cancel_request` is propagated to the exact restore, admission, command, agent turn, configuration, approval, or elicitation operation without changing `session/cancel` semantics.

## Message identity

Harness stream chunks precede creation of the final durable assistant message ID. Buffering until finalization would remove live streaming. The ACP projection therefore derives one stable assistant ID from `sessionId`, `turn`, and `step`, with a `:thought` suffix for the distinct thought stream. Replay uses the same coordinates. Durable user messages reuse their Harness message ID; UI-only command output gets a fresh opaque command ID.

## Usage and cost

`usage_update.used` represents provider-reported prompt pressure: input plus cache-read and cache-write tokens. Output is not added to the current request's occupancy sample. The bridge emits context size only when Harness publishes it and does not estimate monetary cost; `cost` remains absent until a backend owns a reliable cumulative amount and ISO currency.

## Capability negotiation

Stable form elicitation uses `elicitation/create` and validated response guards. Unknown future actions fail closed. Boolean config options are filtered unless the client declares `session.configOptions.boolean`; the current composition has no boolean domain option and therefore advertises none. `model_config` is accepted as the stable semantic category for future model parameters, while the current model and reasoning selectors retain `model` and `thought_level`.
