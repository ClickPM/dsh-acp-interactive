/**
 * Session-owned composition of the published Harness MCP client.
 *
 * The MCP package intentionally reserves server names per Cordis root. ACP,
 * however, permits two sessions to use the same stable server name. Each
 * session therefore receives a private Cordis host while a narrow tools
 * adapter delegates every registration through that agent's scoped context.
 * Protocol handling, discovery, invocation, reconnection, result conversion,
 * and transport teardown remain entirely owned by dsh-mcp-client.
 * @module
 */

import { Context } from '@deepseek-ai/cordis'
import type { McpServer } from '@agentclientprotocol/sdk'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { Config as McpClientConfig } from '@deepseek-ai/dsh-mcp-client'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const HTTP_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** A fully quiescent, idempotent session MCP teardown capability. */
export interface SessionMcpHandle {
  dispose(): Promise<void>
}

/** Error caused by an ACP MCP configuration rather than a server failure. */
export class McpConfigError extends Error {}

/** Secret-safe startup failure for one explicitly requested MCP server. */
export class McpStartupError extends Error {
  constructor(serverName: string) {
    super(`MCP server "${serverName}" initial connection or tool discovery failed`)
    this.name = 'McpStartupError'
  }
}

/** Map and validate the complete live MCP configuration for one session. */
export function mapMcpServers(servers: readonly McpServer[], cwd: string): McpClientConfig[] {
  const names = new Set<string>()
  return servers.map((server, index) => {
    const path = `mcpServers[${index}]`
    if (!SERVER_NAME_PATTERN.test(server.name)) {
      throw new McpConfigError(`${path}.name must match [A-Za-z0-9_-]{1,32}`)
    }
    if (names.has(server.name)) throw new McpConfigError(`${path}.name duplicates MCP server "${server.name}"`)
    names.add(server.name)

    if (!('type' in server) || server.type === undefined) {
      if (server.command.length === 0 || server.command.includes('\0')) {
        throw new McpConfigError(`${path}.command must be a non-empty executable without NUL bytes`)
      }
      if (server.args.some(arg => arg.includes('\0'))) {
        throw new McpConfigError(`${path}.args must not contain NUL bytes`)
      }
      return {
        transport: 'stdio',
        serverName: server.name,
        command: server.command,
        args: [...server.args],
        env: entriesToRecord(server.env, `${path}.env`, false),
        cwd,
        toolCallTimeoutMs: 60_000,
        failOnStartupError: true,
      }
    }

    if (server.type === 'http') {
      let url: URL
      try {
        url = new URL(server.url)
      } catch {
        throw new McpConfigError(`${path}.url must be a valid HTTP or HTTPS URL`)
      }
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') {
        throw new McpConfigError(`${path}.url must be an HTTP or HTTPS URL without embedded credentials`)
      }
      return {
        transport: 'streamable-http',
        serverName: server.name,
        url: url.href,
        headers: entriesToRecord(server.headers, `${path}.headers`, true),
        toolCallTimeoutMs: 60_000,
        failOnStartupError: true,
      }
    }

    if (server.type === 'sse') throw new McpConfigError(`${path}: SSE transport is not supported`)
    if (server.type === 'acp') throw new McpConfigError(`${path}: ACP transport is not supported`)
    /* v8 ignore next -- ACP 1.4.0 validates its closed transport union before dispatch. */
    throw new McpConfigError(`${path}: unsupported MCP transport ${JSON.stringify((server as { type?: unknown }).type)}`)
  })
}

/**
 * Install every requested server before the unpublished agent is published.
 * A failure disposes the whole private host, rolling back earlier servers.
 */
export async function installSessionMcp(
  agentCtx: Context,
  configs: readonly McpClientConfig[],
  signal: AbortSignal,
): Promise<SessionMcpHandle> {
  if (configs.length === 0) return { dispose: () => Promise.resolve() }

  const host = new Context()
  host.provide('tools', {
    register: (definition: ToolDefinition) => agentCtx.tools.register(definition),
  } as never)
  const attachments = agentCtx.get('attachments')
  if (attachments !== undefined) host.provide('attachments', attachments)
  const llm = agentCtx.get('llm')
  /* v8 ignore next -- acp-interactive injects llm; retained for custom composition diagnostics. */
  if (llm !== undefined) host.provide('llm', llm)

  let disposing: Promise<void> | undefined
  const dispose = (): Promise<void> => (disposing ??= host.fiber.dispose())
  // Link the foreign private root to the agent scope. AgentHandle disposal
  // cannot finish until the MCP supervisor has closed and unregistered.
  agentCtx.effect(() => dispose, 'acp-interactive.session-mcp')
  /* v8 ignore next -- the owning request awaits and reports the same disposal failure. */
  const abort = (): void => { void dispose().catch(() => undefined) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    for (const config of configs) {
      try {
        // The package's public apply entry registers its supervisor effects
        // before awaiting initial readiness. Calling it on this private root
        // lets AbortSignal dispose those effects during an in-flight connect;
        // Cordis child-fiber activation otherwise waits for apply to settle
        // before it can begin unloading the same transport.
        await McpClient.apply(host, config)
      } catch {
        signal.throwIfAborted()
        throw new McpStartupError(config.serverName)
      }
      signal.throwIfAborted()
    }
    return { dispose }
  } catch (error: unknown) {
    await dispose()
    signal.throwIfAborted()
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

/** Convert ACP name/value arrays without prototype keys, duplicates, or header injection. */
function entriesToRecord(
  entries: readonly { name: string; value: string }[],
  path: string,
  headers: boolean,
): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  const names = new Set<string>()
  for (const [index, entry] of entries.entries()) {
    const key = headers || process.platform === 'win32' ? entry.name.toLowerCase() : entry.name
    if (entry.name.length === 0 || entry.name === '__proto__' || entry.name === 'constructor'
      || (!headers && /[=\0]/.test(entry.name))
      || (headers && !HTTP_HEADER_NAME_PATTERN.test(entry.name))) {
      throw new McpConfigError(`${path}[${index}].name is invalid`)
    }
    if ((headers && /[\r\n]/.test(entry.value)) || entry.value.includes('\0')) {
      throw new McpConfigError(`${path}[${index}].value is invalid`)
    }
    if (names.has(key)) throw new McpConfigError(`${path}[${index}].name is duplicated`)
    names.add(key)
    result[entry.name] = entry.value
  }
  return result
}
