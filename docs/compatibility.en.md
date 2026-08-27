# Zed Compatibility Matrix

[中文](compatibility.md) | [English](compatibility.en.md)

This matrix applies to `dsh-acp-interactive 0.8.0`, stable ACP v1, and `@agentclientprotocol/sdk 1.4.0`. Results are based on Zed release notes, the current Zed ACP client capability declaration, and this repository's real NDJSON launcher/connection tests.

| Zed version | Status | Capability scope |
| --- | --- | --- |
| `1.16.x` | Recommended; `1.16.3` detected locally | Message IDs, request cancellation, usage, stable form elicitation, select/boolean config capability, and session lifecycle are negotiated through ACP v1. |
| `1.12.x`–`1.15.x` | Minimum supported range for complete Stage A behavior | Stable elicitation is enabled by default from `1.12.0`; session config and boolean toggles had already reached stable releases. Upgrade to the newest patch release. |
| `0.223.x`–`1.11.x` | Compatible with reduced features | Core ACP and select config work. Older clients may omit stable elicitation or boolean-config capabilities, so the bridge hides those optional paths rather than using a permissive fallback. |
| `< 0.223` | Unsupported | These releases lack the complete session-config UI baseline required by this plugin. |

## Verification scope

- Initialization advertises composed load/list/resume/close, prompt modalities, and the MCP HTTP capability; stdio MCP is part of the stable-v1 baseline. SSE, ACP transport, delete, and additional directories remain unadvertised or explicitly rejected.
- Real MCP tests cover stdio/HTTP mapping, tool discovery and invocation, same-name cross-session isolation, new/load/resume, cancellation, failure rollback, connection teardown, and child-process exit.
- SDK schema-conformance tests cover message IDs, `usage_update`/cost fields, `model_config`, boolean set requests, the stable elicitation extensible union, and `$/cancel_request`.
- Request-cancellation tests cancel one long prompt over a real NDJSON connection, prove that another session is unaffected, and then reuse both sessions.
- The current composition has no real boolean domain option, so it displays no invented toggle even when Zed advertises support. Cost is likewise sent only when Harness supplies a trustworthy cumulative amount.

See Zed's [stable release notes](https://zed.dev/releases/stable) and its current [ACP client implementation](https://github.com/zed-industries/zed/blob/main/crates/agent_servers/src/acp.rs).
