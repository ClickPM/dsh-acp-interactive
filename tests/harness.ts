/** In-memory ACP transport over the real agent registry and loop. */

import { Context } from '@deepseek-ai/cordis'
import {
  ClientSideConnection,
  ndJsonStream,
  type Agent as AcpAgent,
  type Client,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
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
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistence, { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import SessionQueryEngine, {
  type SessionEventSearchPage,
  type SessionEventSearchRequest,
  type SessionSearchExecContext,
  type SessionSearchHit,
  type SessionSearchPage,
  type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import * as InteractiveAcp from '../src/index.js'

interface PersistedEntry {
  meta: SessionHeader
  events: readonly SessionEvent[]
}

class HarnessPersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false
  static inject = ['sessions']

  constructor(ctx: Context, private readonly entries: Map<SessionId, PersistedEntry>) {
    super(ctx)
  }

  locate(): undefined {
    return undefined
  }

  create(meta: SessionHeader): Promise<void> {
    this.entries.set(meta.id, { meta: structuredClone(meta), events: [] })
    return Promise.resolve()
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    const entry = this.entries.get(id)
    if (entry === undefined) return Promise.reject(new Error(`missing persisted session: ${id}`))
    entry.events = [...entry.events, ...structuredClone(events)]
    return Promise.resolve()
  }

  load(id: SessionId): Promise<PersistedEntry> {
    return this.inspect(id)
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<PersistedEntry> {
    signal?.throwIfAborted()
    const entry = this.entries.get(id)
    if (entry === undefined) return Promise.reject(new Error(`missing persisted session: ${id}`))
    return Promise.resolve(structuredClone(entry))
  }

  async readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    const entry = await this.inspect(id, signal)
    return { meta: entry.meta, events: entry.events.filter(event => event.seq >= fromSeq) }
  }

  list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    return Promise.resolve([...this.entries.values()].map(entry => structuredClone(entry.meta)))
  }

  listSnapshots(signal?: AbortSignal) {
    signal?.throwIfAborted()
    return Promise.resolve([...this.entries.values()].map(entry => ({
      header: structuredClone(entry.meta),
      revision: SessionPersistenceRevision(JSON.stringify(entry)),
    })))
  }
}

class HarnessSessionQuery extends SessionQueryEngine {
  override searchSessions(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    return Promise.resolve({ items: [] })
  }

  override async searchEvents(
    request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    return { session: (await this.readSurface(request.sessionId)).session, items: [] }
  }
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
      inputModalities: ['text', 'image'],
      reasoning: { efforts: [{ id: 'high' as never, name: 'High' }] },
    })
  }

  override listModels(provider: string): Promise<readonly LlmResolvedModelInfo[]> {
    return Promise.resolve([
      { provider, id: 'mock', name: 'Mock Model', context: { contextWindow: 128_000 } },
      { provider, id: 'alternate', name: 'Alternate Model', context: { contextWindow: 64_000 } },
    ])
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
  elicitationRequests: CreateElicitationRequest[]
  persisted: Map<SessionId, PersistedEntry>
  onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse
  onElicitation: (request: CreateElicitationRequest) => CreateElicitationResponse
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
  const persisted = new Map<SessionId, PersistedEntry>()
  await ctx.plugin(HarnessPersistence, persisted)
  await ctx.plugin(HarnessSessionQuery)
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
  const elicitationRequests: CreateElicitationRequest[] = []
  const harness: BridgeHarness = {
    ctx,
    adapter,
    client: undefined as unknown as ClientSideConnection,
    updates,
    permissionRequests,
    elicitationRequests,
    persisted,
    onPermission: () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
    onElicitation: () => ({ action: 'accept', content: {} }),
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
    unstable_createElicitation(request: CreateElicitationRequest): Promise<CreateElicitationResponse> {
      elicitationRequests.push(request)
      return Promise.resolve(harness.onElicitation(request))
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
