/** In-memory ACP transport over the real agent registry and loop. */

import { Context } from '@deepseek-ai/cordis'
import {
  client,
  methods,
  ndJsonStream,
  type Agent as AcpAgent,
  type ClientSideConnection,
  type ClientConnection,
  type ClientContext,
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
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as toolSkill from '@deepseek-ai/dsh-tool-skill'
import {
  SessionLogOffset,
  type Session,
  type SessionEvent,
  type SessionHeader,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionHandleClosedError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleReadResult,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import SessionQueryEngine, {
  type SessionEventSearchPage,
  type SessionEventSearchRequest,
  type SessionSearchExecContext,
  type SessionSearchHit,
  type SessionSearchPage,
  type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import * as InteractiveAcp from '../src/index.js'

type BridgeClientMethod =
  | 'initialize'
  | 'authenticate'
  | 'newSession'
  | 'listSessions'
  | 'loadSession'
  | 'resumeSession'
  | 'closeSession'
  | 'setSessionConfigOption'
  | 'setSessionMode'
  | 'prompt'
  | 'cancel'

type BridgeClient = ClientContext & {
  [Method in BridgeClientMethod]-?: NonNullable<ClientSideConnection[Method]>
}

interface PersistedEntry {
  meta: SessionHeader
  events: readonly SessionEvent[]
}

/**
 * This fixture stores no fork-seeded sessions, so every logical log it returns
 * starts at offset zero.
 */
const NO_INHERITED_EVENTS = SessionLogOffset(0)

/**
 * One open channel onto a fixture entry. The entry object is captured when the
 * handle opens, so a test that replaces a session's persisted state through
 * `harness.persisted.set()` while the live writer still holds its handle keeps
 * the replacement authoritative for every later read.
 */
class HarnessHandle implements SessionHandle {
  readonly inheritedEventCount = NO_INHERITED_EVENTS
  private closed = false

  constructor(
    readonly id: SessionId,
    readonly access: SessionAccess,
    private readonly entry: PersistedEntry,
    private readonly release: () => void,
  ) {}

  get header(): SessionHeader {
    return this.entry.meta
  }

  read(offset = 0, length?: number): Promise<SessionHandleReadResult> {
    return this.operation('read', () => ({
      eventState: 'detached' as const,
      events: structuredClone(this.entry.events.slice(offset, length === undefined ? undefined : offset + length)),
    }))
  }

  append(events: readonly SessionEvent[]): Promise<void> {
    return this.operation('append', () => {
      if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'append')
      this.entry.events = [...this.entry.events, ...structuredClone(events)]
    })
  }

  /**
   * Route one announced live event. The loop stores a session's
   * pre-publication suffix through `append` before live routing starts, so an
   * event at a seq the entry already holds is that suffix re-announced and is
   * dropped rather than duplicated.
   */
  routeLive(event: SessionEvent): void {
    if (this.closed || this.access !== 'write') return
    if (event.seq < this.entry.events.length) return
    this.entry.events = [...this.entry.events, structuredClone(event)]
  }

  flush(): Promise<void> {
    return this.operation('flush', () => {
      if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'flush')
    })
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.release()
    }
    return Promise.resolve()
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  private operation<T>(name: string, run: () => T): Promise<T> {
    if (this.closed) return Promise.reject(new SessionHandleClosedError(this.id, name))
    try {
      return Promise.resolve(run())
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
}

/**
 * In-memory backend over the handle-based persistence contract. Like the
 * published backends, it owns the routing of announced live events into the
 * one active write handle per session id; the loop only owns the handle.
 */
class HarnessPersistence extends SessionPersistence {
  static inject = ['sessions']
  private readonly writers = new Map<SessionId, HarnessHandle>()

  constructor(ctx: Context, private readonly entries: Map<SessionId, PersistedEntry>) {
    super(ctx)
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.writers.get(session.id)?.routeLive(event)
    })
    ctx.on('session/flush', (session: Session) => this.writers.get(session.id)?.flush())
    ctx.on('session/disposed', (session: Session) => {
      void this.writers.get(session.id)?.close()
    })
  }

  create(header: SessionHeader): Promise<SessionHandle> {
    if (this.entries.has(header.id)) return Promise.reject(new SessionAlreadyExistsError(header.id))
    const entry: PersistedEntry = { meta: structuredClone(header), events: [] }
    this.entries.set(header.id, entry)
    return this.claim(header.id, 'write', entry)
  }

  open(id: SessionId, access: SessionAccess): Promise<SessionHandle> {
    const entry = this.entries.get(id)
    if (entry === undefined) return Promise.reject(new SessionPersistenceNotFoundError(id))
    return this.claim(id, access, entry)
  }

  flush(): Promise<void> {
    return Promise.resolve()
  }

  stat(id: SessionId): Promise<SessionPersistenceSnapshot | undefined> {
    const entry = this.entries.get(id)
    return Promise.resolve(entry === undefined ? undefined : snapshotOf(entry))
  }

  list(): Promise<readonly SessionPersistenceSnapshot[]> {
    return Promise.resolve([...this.entries.values()].map(snapshotOf))
  }

  private claim(id: SessionId, access: SessionAccess, entry: PersistedEntry): Promise<SessionHandle> {
    if (access !== 'write') return Promise.resolve(new HarnessHandle(id, access, entry, () => {}))
    if (this.writers.has(id)) return Promise.reject(new SessionAlreadyOwnedError(id))
    const handle: HarnessHandle = new HarnessHandle(id, access, entry, () => {
      if (this.writers.get(id) === handle) this.writers.delete(id)
    })
    this.writers.set(id, handle)
    return Promise.resolve(handle)
  }
}

function snapshotOf(entry: PersistedEntry): SessionPersistenceSnapshot {
  return {
    header: structuredClone(entry.meta),
    revision: SessionPersistenceRevision(String(entry.events.length)),
    eventCount: entry.events.length,
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

/**
 * One scripted model response: chunks, a hang until abort, or a function of
 * the request, so a response can depend on which agent is asking.
 */
export type ScriptEntry = StreamChunk[] | 'hang' | ((options: GenerateOptions) => StreamChunk[] | 'hang')

/** Scripted model adapter used by bridge tests. */
class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) {
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
    const scripted = this.script.shift()
    if (scripted === undefined) throw new Error('mock script exhausted')
    const entry = typeof scripted === 'function' ? scripted(options) : scripted
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
  client: BridgeClient
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
  script: ScriptEntry[],
  config: Omit<InteractiveAcp.AcpInteractiveConfig, 'stream'> = { provider: 'mock', model: 'mock' },
  providers: string[] = ['mock'],
): Promise<BridgeHarness> {
  const ctx = new Context()
  // The testkit mounts the session projection registry the loop and the
  // permission/approval services fold their state through.
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' } })
  const persisted = new Map<SessionId, PersistedEntry>()
  await ctx.plugin(HarnessPersistence, persisted)
  await ctx.plugin(HarnessSessionQuery)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(toolSkill)
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(providers, adapter)

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
    client: undefined as unknown as BridgeClient,
    updates,
    permissionRequests,
    elicitationRequests,
    persisted,
    onPermission: () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
    onElicitation: () => ({ action: 'accept', content: {} }),
    onSessionUpdateError: undefined,
    closeClientTransport: () => {
      void clientToAgentWriter.close()
      return Promise.resolve()
    },
    abortClientTransport: () => {
      void clientToAgentWriter.abort(new Error('client transport failed'))
      return Promise.resolve()
    },
    acpFiber: undefined as unknown as BridgeHarness['acpFiber'],
    loopFiber,
    dispose: () => ctx.fiber.dispose(),
  }
  const clientApp = client({ name: 'acp-interactive-test-client' })
    .onNotification(methods.client.session.update, ({ params: notification }) => {
      updates.push(notification)
      if (harness.onSessionUpdateError !== undefined) return Promise.reject(new Error('client update rejected'))
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params: request }) => {
      permissionRequests.push(request)
      return Promise.resolve(harness.onPermission(request))
    })
    .onRequest(methods.client.elicitation.create, ({ params: request }) => {
      elicitationRequests.push(request)
      return Promise.resolve(harness.onElicitation(request))
    })

  harness.acpFiber = await ctx.plugin({
    name: 'acp-interactive-test',
    inject: [...InteractiveAcp.inject],
    apply: (inner: Context) => {
      InteractiveAcp.apply(inner, { ...config, stream: agentStream })
    },
  })
  const clientConnection: ClientConnection = clientApp.connect(clientStream)
  harness.closeClientTransport = () => {
    void clientToAgentWriter.abort()
    clientConnection.close()
    return Promise.resolve()
  }
  harness.abortClientTransport = () => {
    const error = new Error('client transport failed')
    void clientToAgentWriter.abort(error)
    clientConnection.close(error)
    return Promise.resolve()
  }
  const agentContext = clientConnection.agent
  harness.client = Object.assign(agentContext, {
    initialize: (params: Parameters<AcpAgent['initialize']>[0]) => (
      agentContext.request(methods.agent.initialize, params)
    ),
    authenticate: (params: Parameters<AcpAgent['authenticate']>[0]) => (
      agentContext.request(methods.agent.authenticate, params)
    ),
    newSession: (params: Parameters<AcpAgent['newSession']>[0]) => (
      agentContext.request(methods.agent.session.new, params)
    ),
    listSessions: (params: Parameters<ClientSideConnection['listSessions']>[0]) => (
      agentContext.request(methods.agent.session.list, params)
    ),
    loadSession: (params: Parameters<NonNullable<AcpAgent['loadSession']>>[0]) => (
      agentContext.request(methods.agent.session.load, params)
    ),
    resumeSession: (params: Parameters<NonNullable<AcpAgent['resumeSession']>>[0]) => (
      agentContext.request(methods.agent.session.resume, params)
    ),
    closeSession: (params: Parameters<NonNullable<AcpAgent['closeSession']>>[0]) => (
      agentContext.request(methods.agent.session.close, params)
    ),
    setSessionConfigOption: (params: Parameters<NonNullable<AcpAgent['setSessionConfigOption']>>[0]) => (
      agentContext.request(methods.agent.session.setConfigOption, params)
    ),
    setSessionMode: (params: Parameters<NonNullable<AcpAgent['setSessionMode']>>[0]) => (
      agentContext.request(methods.agent.session.setMode, params)
    ),
    prompt: (params: Parameters<AcpAgent['prompt']>[0]) => (
      agentContext.request(methods.agent.session.prompt, params)
    ),
    cancel: (params: Parameters<AcpAgent['cancel']>[0]) => (
      agentContext.notify(methods.agent.session.cancel, params)
    ),
  })
  return harness
}
