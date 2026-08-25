/** In-memory ACP transport over the real agent registry and loop. */

import { Context } from '@deepseek-ai/cordis'
import {
  ClientSideConnection,
  ndJsonStream,
  type Agent as AcpAgent,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as InteractiveAcp from '../src/index.js'

/** ES2023-compatible deferred promise for lifecycle tests. */
export function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

/** Scripted model adapter used by bridge tests. */
class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: Array<StreamChunk[] | 'hang'>) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 128_000 },
    })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('mock script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        const fail = (): void => { reject(new Error('aborted')) }
        if (options.signal?.aborted) fail()
        else options.signal?.addEventListener('abort', fail, { once: true })
      })
      return
    }
    for (const chunk of entry) yield chunk
  }
}

/** Text plus reasoning response with provider usage. */
export function reasoningResponse(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'inspect first' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'inspect first' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'done' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'done' } },
    { type: 'usage', usage: { inputTokens: 40, outputTokens: 4, cacheReadTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Text-only scripted model response. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Scripted provider failure after one visible partial chunk. */
export function errorResponse(message: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial' },
    { type: 'finish', reason: { kind: 'error', failure: { message, code: 'PROVIDER_ERROR' } } },
  ]
}

/** Scripted response ending at the output-token limit. */
export function maxTokensResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ]
}

/** Connected test fixture. */
export interface BridgeHarness {
  ctx: Context
  adapter: MockAdapter
  client: ClientSideConnection
  updates: Array<{ sessionId: string; update: SessionNotification['update'] }>
  permissionRequests: RequestPermissionRequest[]
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse
  onSessionUpdateError: (() => void) | undefined
  closeClientTransport(): Promise<void>
  abortClientTransport(): Promise<void>
  acpFiber: Awaited<ReturnType<Context['plugin']>>
  loopFiber: Awaited<ReturnType<Context['plugin']>>
  dispose(): Promise<void>
}

/**
 * Mount the real plugin over cross-wired in-memory streams.
 * @param script - one adapter response per model request.
 * @returns connected client and captured protocol updates.
 */
export async function makeHarness(
  script: Array<StreamChunk[] | 'hang'>,
  config: Omit<InteractiveAcp.AcpInteractiveConfig, 'stream'> = { provider: 'mock', model: 'mock' },
): Promise<BridgeHarness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  await ctx.plugin(CommandRuntime)
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)

  const agentToClient = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>()
  const clientToAgentWriter = clientToAgent.writable.getWriter()
  const clientOutput = new WritableStream<Uint8Array>({
    write: chunk => clientToAgentWriter.write(chunk),
  })
  const agentStream: Stream = ndJsonStream(agentToClient.writable, clientToAgent.readable)
  const clientStream: Stream = ndJsonStream(clientOutput, agentToClient.readable)
  const updates: BridgeHarness['updates'] = []
  const permissionRequests: RequestPermissionRequest[] = []
  const harness: BridgeHarness = {
    ctx,
    adapter,
    client: undefined as unknown as ClientSideConnection,
    updates,
    permissionRequests,
    onPermission: () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
    onSessionUpdateError: undefined,
    closeClientTransport: () => clientToAgentWriter.close(),
    abortClientTransport: () => clientToAgentWriter.abort(new Error('client transport failed')),
    acpFiber: undefined as unknown as BridgeHarness['acpFiber'],
    loopFiber,
    dispose: () => ctx.fiber.dispose(),
  }
  const makeClient = (_agent: AcpAgent): Client => ({
    sessionUpdate(notification: SessionNotification): Promise<void> {
      updates.push(notification)
      if (harness.onSessionUpdateError !== undefined) return Promise.reject(new Error('client update rejected'))
      return Promise.resolve()
    },
    requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      permissionRequests.push(request)
      return Promise.resolve(harness.onPermission(request))
    },
  })

  harness.acpFiber = await ctx.plugin({
    name: 'acp-interactive-test',
    inject: [...InteractiveAcp.inject],
    apply: (inner: Context) => {
      InteractiveAcp.apply(inner, { ...config, stream: agentStream })
    },
  })
  harness.client = new ClientSideConnection(makeClient, clientStream)
  return harness
}
