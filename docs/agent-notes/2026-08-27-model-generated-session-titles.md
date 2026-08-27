# Model-generated ACP Session Titles

ACP already projects durable Harness `session/title` events as `session_info_update`, and session list/load read the same log-backed state. The standalone editor profile previously mounted only the title service bundled by `dsh-agent-spine-demo`. That service intentionally publishes a deterministic prefix fallback, so clients displayed the beginning of the first prompt even though the transport supported later title revisions.

The editor profile now composes the published `@deepseek-ai/dsh-session-title-first-prompt-llm` provider. Title generation remains owned by Harness: the provider selects the first eligible human message, dispatches a separate LLM request, and appends its accepted revision to the session log. The ACP bridge continues to perform event projection only.

The provider inherits the exact provider/model route already recorded for the main request instead of pinning a deployment-specific route. This preserves per-session model selection and custom-provider behavior. Its policy targets five non-CJK words or ten CJK characters, limits framed input to 4096 bytes and output to 32 tokens, and times out after five seconds. The built-in fallback remains immediate; auxiliary failure never delays or fails the main prompt and cannot replace the fallback with a stale result.

Only the first eligible prompt triggers automatic model generation. This bounds auxiliary cost and avoids surprising title churn during long sessions. The auxiliary request and accepted title remain outside main model history and KV-cache identity, while the auxiliary route incurs its own ordinary provider usage.

Built-launcher ACP coverage distinguishes the auxiliary title request from the agent loop, verifies that the generated revision reaches `session_info_update`, and keeps the existing real tool and MCP flows intact. Package manifest, lockfile, packaged Cordis configuration, and editor-profile dependency closure include both the provider plugin and its shared LLM helper.
