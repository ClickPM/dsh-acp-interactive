# Zed Compatibility Matrix

[中文](compatibility.md) | [English](compatibility.en.md)

This matrix applies to `deepseekharness-acp-interactive 1.1.0`, stable ACP v1, and `@agentclientprotocol/sdk 1.4.0`. Results are based on Zed release notes, the current Zed ACP client capability declaration, and this repository's real NDJSON launcher/connection tests.

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
- Session-lifecycle coverage runs two real launchers concurrently with one shared JSONL source and separate in-memory SQLite derived indexes, proving immediate cross-process list/load/resume after close and non-destructive repeated close/restore.
- The current composition has no real boolean domain option, so it displays no invented toggle even when Zed advertises support. Cost is likewise sent only when Harness supplies a trustworthy cumulative amount.

## Pinned upstream baseline

The composed Harness packages are pinned to `0.1.5-rc.1`, and `config/upstream-baseline.json` records the matching official git ref `dsh-v0.1.5-rc.1` that `npm run test:harness` extracts its specs from.

At `0.1.2-rc.1` the official `@deepseek-ai/dsh-acp` transport converged on much of this server's design — it gained `session/list`, `session/resume`, `session/close`, `session/set_config_option`, per-session MCP composition, and `usage_update`. `0.1.5-rc.1` leaves that surface where it was: the official package still pins ACP SDK `1.4.0`, publishes the same twelve spec files, and remains an automation-only transport, so this editor-facing server still advertises strictly more: `session/load`, slash commands and skills, tool-owned presentation cards with diffs and terminal content, form elicitation, permission configuration, and terminal authentication.

What did move at `0.1.5-rc.1` is the runtime underneath: session format v3 embeds each model attempt's provider stream in one durable settlement instead of per-token events, and live text and reasoning deltas reach the editor from the process-local `agent/assistant-stream` frames. Sessions written by earlier releases migrate on first read into a sibling `session.v3.jsonl.zstd` file, so `session/list` and `session/load` keep working on them; see the [Upstream 0.1.5-rc.1 Baseline Agent Note](agent-notes/2026-09-10-upstream-0.1.5-rc.1-baseline.md).

That difference is why only the specs classified as aligned in `config/upstream-baseline.json` run verbatim. The rest are recorded as explicit divergences of two kinds:

- `composition` — the official `tests/harness.ts` composes neither `commands`, `skills`, nor `sessionQuery`, which this server injects to serve slash commands, skills, and `session/load`. Its plugin fiber never activates in that harness, so those specs cannot execute here. Each is covered by this repository's own equivalent suite.
- `internal-api` — the spec imports official private module names or modules introduced by the `0.1.2-rc.1` refactor (`src/model-control.ts`, `src/updates.ts`); `0.1.5-rc.1` changed their bodies but not that private structure. The protocol behavior exists here under this repository's own decomposition.

A recorded divergence is a reviewed statement, not a skip: the gate fails whenever the pinned ref adds, removes, or renames a spec, and reclassifying a spec purely to keep the gate green is prohibited.

See Zed's [stable release notes](https://zed.dev/releases/stable) and its current [ACP client implementation](https://github.com/zed-industries/zed/blob/main/crates/agent_servers/src/acp.rs).
