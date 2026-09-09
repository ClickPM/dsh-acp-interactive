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

## Update: the `auth_required` gate (1.0.6)

Advertising a method turned out to be necessary but not sufficient. Zed (and
the ACP model generally) renders `authMethods` only when a request fails
with the `auth_required` error; a `session/new` that succeeds without a key
simply hides the method until the first model request fails. Removing the
credentials file in Zed produced exactly that: no button, then an error in
the thread.

`session/new` therefore returns `RequestError.authRequired` when both hold:

1. the composition's configured default `provider` is the official DeepSeek
   route (`deepseek-official`), the route the advertised method configures;
2. the composed credentials service reports `describe(DEEPSEEK_API_KEY)` as
   not configured.

The boundary from the decision above holds: the transport never reads the
value (`describe`, not `resolve`), never assumes the route for deployments
that pick another default provider, and skips the check when no credentials
service is composed. `describe` is re-read per call, so the key written by
`--setup` is seen by the next `session/new` on the same connection, which is
the retry Zed performs after terminal authentication. `session/load` and
`session/resume` are not gated: a restored session's route comes from its
log, and a missing key there still fails explicitly at the model request.

One startup race had to be handled explicitly. `credentials-local` stays in
Cordis's `LOADING` state while it canonicalizes and starts watching a
still-absent credentials file — several seconds on Windows — and the strict
`ctx.get('credentials')` every Harness consumer uses returns `undefined`
until the fiber is `ACTIVE`, at which point consumers fall back to
environment variables without noticing. A client's first `session/new`
arrives inside that window. The gate therefore distinguishes "not composed"
(non-strict lookup also empty: return at once) from "composed but starting"
(wait, polling every 50 ms, bounded by `CREDENTIALS_READY_TIMEOUT_MS`
= 10 s and the request's abort signal), and only then reads `describe()`,
whose snapshot is complete once the initial load finished. `describe()`
serves the in-memory snapshot, so a key written while the server runs is
seen after the provider's debounced watcher reloads it (about 100 ms), which
is well inside the human round trip of a terminal login.

A third condition (1.0.7) keeps the gate from trapping multi-provider users:
it applies only while `ctx.llm.listProviders()` lists no provider other than
`deepseek-official`. A `settings.yaml` that adds `llm-pi-ai` routes means the
user may hold credentials for those routes and switch the session to them;
blocking `session/new` on the DeepSeek key would make that impossible, since
clients offer no way past the authentication panel. A fresh installation has
only the DeepSeek route and still gets the prompt.

Two more facts surfaced when the panel finally appeared in Zed (1.0.8).
First, the button did nothing: Zed's `terminal_auth_task` handles a stable
`type: "terminal"` method only behind its `AcpBetaFeatureFlag` and otherwise
parses a legacy `_meta["terminal-auth"]` object on the method
(`{ label, command, args?, env? }`, `command` required) — the format
opencode ships. The method therefore carries both. The legacy object cannot
rely on PATH or on the agent's configured command, so it names
`process.execPath` and this package's own `bin.js` with `--setup`, valid for
a global install, a Registry `npx` cache, and a checkout; `DSH_HOME` is
forwarded when the server was started with one so setup writes the same
home. Second, Zed retries `session/new` the instant the setup terminal
exits, while the credential provider's debounced watcher loads the new file
about 100 ms later; the gate now keeps re-reading `describe()` for
`CREDENTIAL_SETTLE_MS` (1 s) before answering `auth_required`, which costs a
fresh installation one second before its first authentication panel.

Probing the built launcher by hand also showed that it did not exit when its
stdin closed: the plugin quiesces the connection, but `bin.ts` only exited
on `SIGINT`/`SIGTERM`, and the composition's file watchers kept the event
loop alive. The launcher now disposes the composition and exits on stdin
`end` as well, which is what a client closing the transport means.

Real-launcher tests that create sessions on the default route now run with
`DEEPSEEK_API_KEY` set; a dedicated launcher test covers the gate,
`authenticate`, and the pickup of a key stored afterwards, and unit tests
cover the readiness wait, its bound, abort, and the uncomposed case.

## Consequences

- Clients without terminal authentication now show one authentication
  action that succeeds instantly; the useful part is its description.
- Opening a thread without a configured key yields the authentication
  action immediately; clients that do not implement `auth_required` still
  see the method in `initialize`.
- The Registry submission (agentclientprotocol/registry#585) moves to the
  `dsh-acp-interactive/` directory; `registry-auth.yml` and
  `check-registry-entry.mjs` follow the entry's `id` automatically.
- Tests that pinned the old `agentInfo` name and version now read the
  version from `package.json`.
