# Session-Scoped MCP Lifecycle

Release `0.8.0` accepts complete MCP configuration only at `session/new`, `session/load`, and `session/resume`. The configuration is live connection state, not durable session state: stdio executable/argv/env and HTTP URL/headers are never appended to the Harness session log, copied into model context, or inherited by a later restore. A restore with no servers removes MCP; a changed configuration starts only the new servers; a failed configuration leaves no active agent or connection.

## Published owner and startup transaction

`@deepseek-ai/dsh-mcp-client@0.1.1-rc.2` remains the sole owner of MCP protocol negotiation, transport construction, discovery, calls, result conversion, reconnect policy, and transport shutdown. The bridge maps stable ACP v1 stdio and HTTP records to that package's `stdio` and `streamable-http` configs with `failOnStartupError: true`. SSE, ACP-proxied MCP, embedded URL credentials, invalid headers/env, duplicate server names, and unknown variants fail before agent publication.

Every requested server is installed during `AgentRegistry.create/resume` setup. The setup is a transaction: a configuration error starts nothing, and any later server or response-assembly failure disposes the entire session MCP host before the request rejects. Startup errors returned to ACP identify only the stable server name and failure phase; transport causes are intentionally not chained into the response, so env and header values cannot appear in ordinary diagnostics.

The package publicly exports asynchronous `apply(ctx, config)`. The bridge invokes this entry directly on the private root instead of awaiting a Cordis child-plugin activation. `apply` registers the MCP supervisor's effects before awaiting initial readiness, which allows the session AbortSignal to dispose those effects and abort an in-flight HTTP handshake. A child plugin fiber would wait for its asynchronous activation to settle before unloading, making an unresponsive first handshake impossible to interrupt. No transport or MCP behavior is reimplemented by this choice.

## Same-name isolation without name leakage

The published MCP client reserves `serverName` in an `activeServerNames` set keyed by `ctx.root`. Installing two instances under ordinary agent contexts in the same application root would therefore reject the same stable name across sessions. Expanding tool registration to the global registry or adding a random session suffix to the public name would break agent isolation or restoration stability, so both approaches are rejected.

Each ACP session instead receives a private Cordis root. A narrow `tools` service adapter delegates `register(definition)` to the exact unpublished `agentCtx.tools.register(definition)`. Optional attachment and LLM services are forwarded for the MCP package's rich-result admission. Consequently, server-name reservations are private to one session while all tool definitions live only in the corresponding Harness agent scope. Public names remain the package-owned deterministic `mcp__<serverName>__<rawName>` form, with no session identifier exposed to the model.

## Quiescence and cancellation

The private root is linked to the agent fiber by an idempotent effect and also exposed as the session's explicit MCP handle. Session close and connection teardown first cancel and settle admission/command/agent work, then dispose MCP and the `AgentHandle`, attempting both even if one reports an error. Prompt cancellation waits for the exact tool execution and output tail before disposing MCP, so no reconnect or late tool result can survive the cancelled turn.

Private-root disposal delegates quiescence to the MCP client's supervisor: it closes the current SDK client/transport, stops reconnect timers, waits for connection and tool-sync chains, unregisters the current tool generation, and waits for stdio process exit. Aborting creation invokes the same disposal while initial readiness is pending. Tests cover real stdio and Streamable HTTP, child-process exit, same-name concurrent sessions, partial-start rollback, new/load/resume replacement, prompt cancellation, established connection teardown, and interruption of a hanging initial HTTP handshake.

## Capability and release boundary

Stable ACP v1 treats stdio as the baseline MCP transport and gates HTTP with `mcpCapabilities.http`; `0.8.0` advertises HTTP only and does not advertise SSE or ACP transport. The packed launcher declares the MCP client plus its subprocess and timeout peers as runtime dependencies, while MCP servers themselves remain request-owned external processes or endpoints.

Additional directories is unchanged by this release. Non-empty `additionalDirectories` continues to fail explicitly under the separate boundary recorded in `2026-08-27-additional-directories-boundary.md`.
