# Agent Note: Registry Terminal Authentication

## Decision

The standalone launcher advertises a `terminal` ACP authentication method only
when the client declares `clientCapabilities.auth.terminal: true`. The method
launches the same executable with `--setup`. That invocation boots a minimal
composition containing only `dsh-credentials-local`, prompts without echoing
the key, and writes the `DEEPSEEK_API_KEY` reference through
`ctx.credentials.set()`.

The ordinary launcher composition and transport are not started during setup.
Conversely, ordinary ACP mode never prompts and keeps stdout reserved for
JSON-RPC.

## Why terminal auth

The official DeepSeek adapter authenticates with an API key rather than an
agent-owned OAuth flow. ACP terminal auth lets Zed reproduce the configured
agent invocation in a user-visible terminal without passing the secret through
the ACP handshake, Registry manifest, or editor settings.

Writing YAML directly in this repository was rejected. It would duplicate the
credentials domain's strict document parser, environment precedence,
cross-process lock, atomic patching, hot-update semantics, and file permission
policy. The setup process therefore owns only interaction and delegates the
write to the published provider.

## Precedence and validation

An inherited `DEEPSEEK_API_KEY` is read-only and outranks the managed file. If
it is present, setup reports that authentication is already configured and
does not attempt an ineffective write. A blank answer preserves an existing
writable key but rejects a new empty credential. Control characters are
rejected before storage; provider/API validity remains the official adapter's
responsibility on the first request, so setup performs no network call.

## Security boundary

The secret is not echoed or logged. The local provider creates an owner-only
directory and credential file on POSIX. This is not isolation from another
process running as the same OS user, including an agent tool deliberately
reading the known path; that limitation remains owned and documented by
`dsh-credentials-local`.
