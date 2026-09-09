# Personal Agent Config Integration Boundary

## Decision

`dsh-acp-interactive` remains a general ACP server with no dependency on a personal configuration repository, home-directory layout, credential store, or MCP bridge implementation. A client may supply MCP stdio records whose executable happens to be `agent-config-mcp`, but this package treats them exactly like every other ACP-provided stdio server.

The personal control plane shares only static MCP definitions, workspace scopes, credential references, tool allow-lists, and LLM route metadata. Runtime state is never shared across consumers.

## Zed ACP path

Zed owns its `context_servers` definitions. Each managed service starts one standard stdio bridge, and Zed forwards the resulting command/argv record in `session/new`, `session/load`, or `session/resume`. The existing ACP mapping creates a private Cordis root for that exact session, delegates tool registration only to that agent scope, and owns strict startup, rollback, cancellation, and teardown.

No personal MCP consumer is composed in `config/cordis.yml`. Adding one would create a second owner alongside Zed forwarding and could duplicate tools, connections, credentials, and cancellation state.

## Standalone WebUI path

The `npx dsh` WebUI is a separate process and does not receive Zed's ACP request. Its personal preset may compose a local consumer that starts the same standard bridge command, provided the consumer creates a new private Cordis root for every Harness agent and links that root's disposal to the agent lifetime.

The WebUI consumer and its local paths belong outside this repository. Its service list is deployment configuration, not an invariant of the ACP package. It must not reuse an MCP client, server-name registry, tool registry, session ID, cancellation controller, subprocess, or reconnect worker across agents.

## Credential boundary

Credentials are resolved by the client-side bridge and sent only to its one upstream service. ACP receives only the bridge command and argv. Bridge stdout is MCP framing; diagnostics suppress credential values. The ACP session log and model context receive neither source references nor materialized headers/environment values.

This arrangement allows one user's control plane to serve Zed Agent, Zed ACP agents, Pi/Harness, Cursor, and Codex while the published `dsh-acp-interactive` package remains installable and functional on machines that have never installed that control plane.
