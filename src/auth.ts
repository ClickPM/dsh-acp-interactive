/**
 * ACP authentication surface for the official DeepSeek route: the advertised
 * method, and the `auth_required` gate that lets clients show it before the
 * first prompt. Credential storage and resolution stay with the composed
 * Harness credentials service.
 */

import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { RequestError, type AuthMethod, type InitializeRequest } from '@agentclientprotocol/sdk'
import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'

/** Reference the official DeepSeek adapter resolves by default. */
export const DEEPSEEK_API_KEY = credentialRef('DEEPSEEK_API_KEY')

/** Provider route id registered by `@deepseek-ai/dsh-llm-deepseek`. */
export const DEEPSEEK_PROVIDER = 'deepseek-official'

const METHOD_ID = 'deepseek-api-key'
const METHOD_NAME = 'Configure DeepSeek API key'
const SETUP_ARGS = ['--setup']
const SETUP_HINT = 'Run `dsh-acp-interactive --setup` in a terminal to store DEEPSEEK_API_KEY in the local DeepSeek Harness credential store, or set DEEPSEEK_API_KEY in the environment.'

/** How long `session/new` waits for a composed credentials service that is still starting. */
export const CREDENTIALS_READY_TIMEOUT_MS = 10_000

/**
 * How long `session/new` keeps re-reading an unconfigured key before failing.
 * A client retries `session/new` the moment the `--setup` terminal exits, and
 * the credential provider's debounced watcher reloads the file about 100 ms
 * after the write; without this grace a successful setup would be answered
 * with a second `auth_required`.
 */
export const CREDENTIAL_SETTLE_MS = 1_000

type CredentialsLookup = Pick<Context, 'get'>
type Credentials = Pick<CredentialProvider, 'describe'>
/** The slice of the plugin context the gate reads: service lookup and the provider directory. */
export type GateContext = CredentialsLookup & { llm: { listProviders(): ReadonlyArray<{ id: string }> } }

/** Environment the setup process must share with this server: only an explicit home override. */
function setupEnvironment(): Record<string, string> {
  const home = process.env.DSH_HOME
  return home === undefined || home.length === 0 ? {} : { DSH_HOME: home }
}

/**
 * Zed's stable releases run terminal methods only through this legacy object
 * on the method (its stable `type: "terminal"` path sits behind a beta flag),
 * and the object must name an executable itself. The running Node executable
 * plus this package's own `bin.js` holds for every distribution - a global
 * install, a registry `npx` cache, or a checkout - without relying on PATH.
 */
function legacyTerminalMeta(): Record<string, unknown> {
  return {
    'terminal-auth': {
      label: METHOD_NAME,
      command: process.execPath,
      args: [fileURLToPath(new URL('./bin.js', import.meta.url)), ...SETUP_ARGS],
      env: setupEnvironment(),
    },
  }
}

/**
 * One `deepseek-api-key` method is always advertised. Clients that declare
 * terminal authentication (stable `auth.terminal` or the Registry's legacy
 * `_meta["terminal-auth"]` flag) get the `--setup` terminal method; other
 * clients get an agent-type entry carrying the same instructions, so a client
 * never sees an empty list and mistakes it for "no authentication needed".
 */
export function authMethodsFor(capabilities: InitializeRequest['clientCapabilities']): AuthMethod[] {
  const terminal = capabilities?.auth?.terminal === true
    || capabilities?._meta?.['terminal-auth'] === true
  if (terminal) {
    const env = setupEnvironment()
    return [{
      id: METHOD_ID,
      name: METHOD_NAME,
      description: 'Store DEEPSEEK_API_KEY in the local DeepSeek Harness credential store.',
      type: 'terminal',
      args: SETUP_ARGS,
      ...Object.keys(env).length === 0 ? {} : { env },
      _meta: legacyTerminalMeta(),
    }]
  }
  return [{ id: METHOD_ID, name: METHOD_NAME, description: SETUP_HINT }]
}

/**
 * The composed credentials service once its plugin is active, or `undefined`
 * when none is composed. `credentials-local` stays in the loading state while
 * it canonicalizes and watches a still-absent credentials file, which on
 * Windows outlasts a client's first `session/new` after launch; the strict
 * lookup every Harness consumer uses returns nothing until then, and its
 * `describe()` snapshot is only complete once the initial load finished. A
 * service that is provided but not yet active is therefore awaited, bounded
 * by `timeoutMs`, while an uncomposed service returns immediately.
 */
async function activeCredentials(
  ctx: CredentialsLookup,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Credentials | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const active = ctx.get('credentials') as Credentials | undefined
    if (active !== undefined) return active
    if (ctx.get('credentials', false) === undefined) return undefined
    if (Date.now() >= deadline) return undefined
    await sleep(50, undefined, { signal })
  }
}

/**
 * Reject `session/new` with the ACP `auth_required` error while the
 * composition's default route is the official DeepSeek provider and its key
 * is not configured. Clients render `authMethods` only on that error, so
 * without it a missing key surfaces as a model-call failure after the first
 * prompt. The check reads `describe()`, never the value, and re-reads per
 * call so a key stored by `--setup` is seen by the next `session/new`.
 * Deployments that select another default provider are not gated: the
 * transport cannot know which credential that route needs. Nor is a
 * deployment whose model directory offers other providers, for example
 * `llm-pi-ai` routes from `settings.yaml`: the user may hold credentials for
 * those routes and switch to them, and a missing DeepSeek key then fails only
 * when the DeepSeek route is actually used.
 */
export async function assertSessionCredential(
  ctx: GateContext,
  config: { provider?: string },
  signal?: AbortSignal,
  readyTimeoutMs = CREDENTIALS_READY_TIMEOUT_MS,
  settleMs = CREDENTIAL_SETTLE_MS,
): Promise<void> {
  if (config.provider !== DEEPSEEK_PROVIDER) return
  if (ctx.llm.listProviders().some(provider => provider.id !== DEEPSEEK_PROVIDER)) return
  await requireDeepSeekKey(ctx, signal, readyTimeoutMs, settleMs)
}

/**
 * The same check for a session's current route at prompt time, without the
 * provider-directory exemption: a session that is about to call the official
 * DeepSeek route without a key gets `auth_required` instead of an internal
 * model-call error, and clients show the method for it. Other routes are not
 * inspected. Direct commands never reach the model and are not gated.
 */
export async function assertRouteCredential(
  ctx: CredentialsLookup,
  provider: string | undefined,
  signal?: AbortSignal,
  readyTimeoutMs = CREDENTIALS_READY_TIMEOUT_MS,
  settleMs = CREDENTIAL_SETTLE_MS,
): Promise<void> {
  if (provider !== DEEPSEEK_PROVIDER) return
  await requireDeepSeekKey(ctx, signal, readyTimeoutMs, settleMs)
}

async function requireDeepSeekKey(
  ctx: CredentialsLookup,
  signal: AbortSignal | undefined,
  readyTimeoutMs: number,
  settleMs: number,
): Promise<void> {
  const credentials = await activeCredentials(ctx, signal, readyTimeoutMs)
  if (credentials === undefined) return
  const deadline = Date.now() + settleMs
  for (;;) {
    const info = await credentials.describe(DEEPSEEK_API_KEY)
    if (info.configured) return
    if (Date.now() >= deadline) break
    await sleep(100, undefined, { signal })
  }
  throw RequestError.authRequired(undefined, `DEEPSEEK_API_KEY is not configured. ${SETUP_HINT}`)
}
