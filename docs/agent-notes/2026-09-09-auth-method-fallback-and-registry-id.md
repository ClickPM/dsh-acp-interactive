# Auth Method Fallback and Registry Id

## Context

Since `1.0.1` the launcher advertised its `terminal` authentication method
only when the client declared `clientCapabilities.auth.terminal` or the
legacy `_meta["terminal-auth"]` flag, and returned an empty `authMethods`
list otherwise. That matches the letter of the stable ACP text ("when `true`,
the agent may include `terminal` entries"), but it leaves clients that do
not declare the capability with no authentication entry at all.

The ACP Registry is curated by JetBrains and Zed maintainers who install
submissions and run them in IntelliJ. A logged IntelliJ IDEA 2026.1 EAP
handshake in the Registry repository sends
`{"fs":{...},"terminal":false}` with neither flag. With the old gate such a
client would see no way to configure a key and would fail at the first model
request; the Registry maintainers have declined entries for exactly that
symptom ("agents should not require any additional console setup").

Merged entries that depend on a locally stored API key handle this by always
listing a method: `opencode` returns a plain method that gains terminal
metadata only when the client supports it, and `glm-acp-agent` always
returns an agent-type method whose description names its `--setup` command.

## Decision

- `initialize` always returns one `deepseek-api-key` method. When the client
  declares terminal authentication it is the existing `terminal` method with
  `args: ["--setup"]`; otherwise it is an agent-type method (no `type`,
  which the specification and the Registry validator treat as `agent`) whose
  description tells the user to run `dsh-acp-interactive --setup` or set
  `DEEPSEEK_API_KEY`.
- `authenticate` keeps resolving immediately for either method. The transport
  does not inspect credentials: which key a session needs depends on the
  selected provider route, and the Harness credential store resolves it at
  the first model request, where a missing key already fails explicitly.
- `agentInfo.version` is read from `package.json`; `agentInfo.name` becomes
  `dsh-acp-interactive`.
- The Registry entry id changes from `deepseek-harness-interactive` to
  `dsh-acp-interactive`, matching the repository and executable names and
  the `-acp` convention maintainers asked wrappers to follow, and its
  description states that the project is community-maintained, unofficial,
  and not affiliated with DeepSeek. The npm package name is unchanged.

## Alternatives Rejected

- **Keep the empty list for clients without the capability.** Rejected: it
  is indistinguishable from "no authentication needed" for a client, and it
  is the failure mode the Registry rejects.
- **Have `authenticate` verify that `DEEPSEEK_API_KEY` exists.** Rejected:
  it would make the transport depend on the credentials service and assume
  the DeepSeek route, while sessions may use other configured providers.
- **Advertise a `terminal` method regardless of client capability.**
  Rejected: a client that cannot spawn the invocation in a terminal would
  show an action it cannot perform; the stable text ties `terminal` entries
  to the capability.

## Consequences

- Clients without terminal authentication now show one authentication
  action that succeeds instantly; the useful part is its description.
- The Registry submission (agentclientprotocol/registry#585) moves to the
  `dsh-acp-interactive/` directory; `registry-auth.yml` and
  `check-registry-entry.mjs` follow the entry's `id` automatically.
- Tests that pinned the old `agentInfo` name and version now read the
  version from `package.json`.
