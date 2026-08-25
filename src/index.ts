/**
 * Interactive Agent Client Protocol server for editor-hosted dsh sessions.
 *
 * The plugin projects the durable session stream onto ACP UI updates while the
 * harness retains ownership of model calls, tools, permissions, and teardown.
 * @module dsh-acp-interactive
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type Agent as AcpAgent,
  type AnyMessage,
  type AuthenticateRequest,
  type AvailableCommand,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionNotification,
  type StopReason,
  type Stream,
} from '@agentclientprotocol/sdk'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, errorChain, type ContentBlock, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type TodoItem, type TurnEndReason } from '@deepseek-ai/dsh-session'
// Declaration merges for the plugin-owned events and services projected below.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-tools'
import { admitTextPrompt, admittedText, InteractivePromptError } from './content.js'
import { turnEndToStopReason } from './codec.js'
import {
  projectToolCall,
  projectToolResult,
  ToolPresenter,
  type TerminalRendering,
} from './presentation.js'

export const name = 'acp-interactive'
/** Interactive UI dependencies; model and tool providers remain composition choices. */
export const inject = ['agents', 'commands', 'tools', 'sessionPersistence', 'sessionQuery']

/** Provider/model defaults for agents created by this ACP server. */
export interface AcpInteractiveConfig {
  /** Provider route for created agents. */
  provider?: string
  /** Model id for created agents. */
  model?: string
  /** Runtime-only transport override; production uses stdio. */
  stream?: Stream
}

/** Runtime configuration schema. */
export const Config: Schema<AcpInteractiveConfig> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
})

interface AgentInflight {
  kind: 'agent'
  resolve: (reason: StopReason) => void
  reject: (error: Error) => void
  messageId: string
  turn: number | undefined
  endReason: TurnEndReason | undefined
  agentError: Error | undefined
  cancelRequested: boolean
  settlementStarted: boolean
}

interface CommandInflight {
  kind: 'command'
  controller: AbortController
  cancelRequested: boolean
  done: Promise<void>
  finish: () => void
}

interface UsageState {
  size: number | undefined
  used: number
  lastSample: string | undefined
}

interface SessionRecord {
  agent: Agent
  dispose: () => Promise<void>
  presenter: ToolPresenter
  terminal: TerminalRendering
  outputTail: Promise<void>
  usage: UsageState
  inflight: AgentInflight | CommandInflight | undefined
  closing: Promise<void> | undefined
}

interface StartOperation {
  controller: AbortController
  done: Promise<void>
  finish: () => void
}

interface ContinuableDrain {
  /** Drain continuable descendants below the exact bridge-owned parents. */
  drainContinuableDescendants(parents: readonly Agent[]): Promise<void>
}

/**
 * Mount the editor-facing ACP server.
 * @param ctx - Cordis context carrying the agent, command, and tool registries.
 * @param config - provider/model defaults and optional test transport.
 */
export function apply(ctx: Context, config: AcpInteractiveConfig): void {
  const agents = ctx.agents
  const commands = ctx.commands
  const tools = ctx.tools
  const logger = ctx.logger
  const sessions = new Map<SessionId, SessionRecord>()
  const startingSessions = new Map<SessionId, StartOperation>()
  const pendingCommandSnapshots = new Map<SessionId, SessionRecord>()
  let closed = false
  let terminalOutputEnabled = false
  let conn: AgentSideConnection
  let drainTail = Promise.resolve()

  const assertOpen = (): void => {
    if (closed) throw internalError('the interactive ACP bridge has been disposed')
  }

  const requireSession = (sessionId: SessionId): SessionRecord => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
    if (record.closing !== undefined) throw invalidParams(`session is closing: ${sessionId}`)
    return record
  }

  const ownedRecord = (agent: Agent): SessionRecord | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.agent === agent ? record : undefined
  }

  const notify = (record: SessionRecord, update: SessionNotification['update']): void => {
    const delivery = record.outputTail.then(() => conn.sessionUpdate({
      sessionId: record.agent.session.id,
      update,
    }))
    record.outputTail = delivery.catch((error: unknown) => {
      logger.warn(`acp-interactive: session/update failed: ${String(error)}`)
    })
  }

  const availableCommands = (record: SessionRecord): AvailableCommand[] =>
    commands.list(record.agent).map(command => ({
      name: command.name,
      description: command.description,
      ...command.input === undefined ? {} : { input: { hint: command.input.hint } },
    }))

  const notifyCommands = (record: SessionRecord): void => {
    notify(record, {
      sessionUpdate: 'available_commands_update',
      availableCommands: availableCommands(record),
    })
  }

  const makeRecord = (handle: AgentHandle): SessionRecord => ({
    agent: handle.agent,
    dispose: () => handle.dispose(),
    presenter: new ToolPresenter(
      tools,
      (message) => { logger.warn(message) },
      handle.agent,
    ),
    terminal: { enabled: terminalOutputEnabled, cwd: handle.agent.session.header.cwd },
    outputTail: Promise.resolve(),
    usage: { size: undefined, used: 0, lastSample: undefined },
    inflight: undefined,
    closing: undefined,
  })

  const drainDescendants = (parents: readonly Agent[]): Promise<void> => {
    const subagents = ctx.get('subagents') as ContinuableDrain | undefined
    if (subagents === undefined) return Promise.resolve()
    const drain = drainTail.then(() => subagents.drainContinuableDescendants(parents))
    drainTail = drain.catch((error: unknown) => {
      logger.warn(`acp-interactive: continuable subagent teardown failed: ${String(error)}`)
    })
    return drainTail
  }

  const cancelRecord = (record: SessionRecord, reason: Error): void => {
    const inflight = record.inflight
    if (inflight?.kind === 'command') {
      inflight.cancelRequested = true
      inflight.controller.abort(reason)
    } else if (inflight?.kind === 'agent') {
      inflight.cancelRequested = true
      settleAfterQuiescence(record, inflight)
    }
    record.agent.cancel({ kind: 'user' })
  }

  const awaitRecordIdle = async (record: SessionRecord): Promise<void> => {
    const inflight = record.inflight
    if (inflight?.kind === 'command') await inflight.done
    await record.agent.whenIdle()
    await record.outputTail
  }

  const closeRecord = (record: SessionRecord): Promise<void> => {
    if (record.closing !== undefined) return record.closing
    const sessionId = record.agent.session.id
    record.closing = (async () => {
      cancelRecord(record, new Error('ACP session closed'))
      await awaitRecordIdle(record)
      await drainDescendants([record.agent])
      await record.dispose()
    })().finally(() => {
      /* v8 ignore next -- the exact record stays mapped until this owner finishes closing it. */
      if (sessions.get(sessionId) === record) sessions.delete(sessionId)
      /* v8 ignore next -- an outbound session response normally clears this before a client can close it. */
      if (pendingCommandSnapshots.get(sessionId) === record) pendingCommandSnapshots.delete(sessionId)
    })
    return record.closing
  }

  const resumeRecord = async (
    params: LoadSessionRequest | ResumeSessionRequest,
    replay: boolean,
  ): Promise<{ record: SessionRecord; events: readonly SessionEvent[] }> => {
    assertOpen()
    validateRestoredSessionParams(params)
    const sessionId = SessionId(params.sessionId)
    if (sessions.has(sessionId) || startingSessions.has(sessionId)) {
      throw invalidParams(`session is already active in this ACP connection: ${sessionId}`)
    }
    if (agents.get(sessionId) !== undefined) {
      throw invalidParams(`session is already active outside this ACP connection: ${sessionId}`)
    }

    const settled = Promise.withResolvers<void>()
    const start: StartOperation = {
      controller: new AbortController(),
      done: settled.promise,
      finish: () => { settled.resolve() },
    }
    startingSessions.set(sessionId, start)
    try {
      const snapshot = await ctx.sessionQuery.readSession(sessionId)
      if (snapshot.session.cwd === undefined) {
        throw invalidParams(`session has no recorded cwd: ${sessionId}`)
      }
      if (snapshot.session.cwd !== params.cwd) {
        throw invalidParams(`cwd does not match session ${sessionId}: expected ${snapshot.session.cwd}`)
      }
      if (replay) validateReplayableHistory(snapshot.events)
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: agentOptions(config),
        signal: start.controller.signal,
      })
      if (closed || start.controller.signal.aborted) {
        await handle.dispose()
        throw internalError('connection closed during session restore')
      }
      const record = makeRecord(handle)
      sessions.set(sessionId, record)
      return { record, events: snapshot.events }
    } catch (error: unknown) {
      if (error instanceof RequestError) throw error
      throw internalError(`session restore failed: ${errorChain(error)}`)
    } finally {
      /* v8 ignore next -- this exact operation owns the map entry until its finally block. */
      if (startingSessions.get(sessionId) === start) startingSessions.delete(sessionId)
      start.finish()
    }
  }

  const announceInitialCommands = (message: AnyMessage): void => {
    const sessionId = responseSessionId(message)
    if (sessionId === undefined) return
    const record = pendingCommandSnapshots.get(sessionId)
    if (record === undefined) return
    pendingCommandSnapshots.delete(sessionId)
    notifyCommands(record)
  }

  ctx.on('commands/change', () => {
    for (const record of sessions.values()) {
      if (!pendingCommandSnapshots.has(record.agent.session.id)) notifyCommands(record)
    }
  })

  const settleAfterQuiescence = (record: SessionRecord, inflight: AgentInflight): void => {
    if (inflight.settlementStarted) return
    inflight.settlementStarted = true
    void (async () => {
      await record.agent.whenIdle()
      await record.outputTail
      /* v8 ignore next -- this exact prompt owns the slot until settlement clears it. */
      if (record.inflight !== inflight) return
      record.inflight = undefined
      if (inflight.cancelRequested) {
        inflight.resolve('cancelled')
      } else if (inflight.agentError !== undefined) {
        inflight.reject(internalError(`turn failed: ${inflight.agentError.message}`))
      } else if (inflight.endReason?.kind === 'error') {
        inflight.reject(internalError(`turn failed: ${inflight.endReason.error.message}`))
      } else {
        inflight.resolve(inflight.endReason === undefined ? 'cancelled' : turnEndToStopReason(inflight.endReason))
      }
    })()
    /* v8 ignore start -- whenIdle and the contained output tail cannot reject. */
      .catch((error: unknown) => {
        if (record.inflight !== inflight) return
        record.inflight = undefined
        inflight.reject(internalError(`prompt settlement failed: ${errorChain(error)}`))
      })
    /* v8 ignore stop */
  }

  ctx.on('session/event', (session, event: SessionEvent) => {
    const record = sessions.get(session.id)
    if (record === undefined || record.agent.session !== session) return
    try {
      for (const update of projectEvent(record, event)) notify(record, update)
    } catch (error: unknown) {
      logger.warn(`acp-interactive: event projection failed: ${errorChain(error)}`)
    } finally {
      const inflight = record.inflight
      if (inflight?.kind === 'agent' && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        inflight.endReason = event.data.reason
        settleAfterQuiescence(record, inflight)
      }
    }
  })

  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
    const inflight = ownedRecord(agent)?.inflight
    if (inflight?.kind === 'agent' && inflight.messageId === message.id) inflight.turn = turn
  })

  ctx.on('agent/error', ({ agent, turn, error }) => {
    const record = ownedRecord(agent)
    const inflight = record?.inflight
    if (record === undefined || inflight?.kind !== 'agent' || inflight.turn === turn) return
    inflight.agentError = new Error(errorChain(error))
    settleAfterQuiescence(record, inflight)
  })

  ctx.on('approval/request', (request, next) => {
    const record = ownedRecord(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    return conn.requestPermission({
      sessionId: record.agent.session.id,
      toolCall: { toolCallId: request.callId },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    }).then(({ outcome }) => {
      if (outcome.outcome === 'cancelled') return 'cancelled'
      return outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
    })
  })

  const runCommand = async (
    record: SessionRecord,
    text: string,
    inflight: CommandInflight,
  ): Promise<PromptResponse> => {
    try {
      const execution = await commands.execute(record.agent, text, inflight.controller.signal)
      const rendered = execution === undefined
        ? `Error: unknown command: ${text}`
        : execution.result.kind === 'error'
          ? `Error: ${execution.result.text}`
          : execution.result.text
      if (rendered !== undefined && rendered.length > 0) {
        notify(record, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: rendered },
        })
        await record.outputTail
      }
      return { stopReason: 'end_turn' }
    } catch (error: unknown) {
      if (inflight.cancelRequested || inflight.controller.signal.aborted) return { stopReason: 'cancelled' }
      notify(record, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Error: command failed: ${renderThrown(error)}` },
      })
      await record.outputTail
      return { stopReason: 'end_turn' }
    } finally {
      /* v8 ignore next -- this command owns the slot until its own finally block. */
      if (record.inflight === inflight) record.inflight = undefined
      inflight.finish()
    }
  }

  const makeAgent = (connection: AgentSideConnection): AcpAgent => {
    conn = connection
    return {
      initialize(params: InitializeRequest): Promise<InitializeResponse> {
        terminalOutputEnabled = params.clientCapabilities?._meta?.['terminal_output'] === true
        return Promise.resolve({
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: 'deepseek-harness-interactive-acp', version: '0.2.0' },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            sessionCapabilities: {
              list: {},
              resume: {},
              close: {},
            },
          },
          authMethods: [],
        })
      },

      authenticate(_params: AuthenticateRequest): Promise<void> {
        return Promise.resolve()
      },

      async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
        assertOpen()
        validateSessionParams(params)
        const sessionId = SessionId(randomUUID())
        const settled = Promise.withResolvers<void>()
        const start: StartOperation = {
          controller: new AbortController(),
          done: settled.promise,
          finish: () => { settled.resolve() },
        }
        startingSessions.set(sessionId, start)
        try {
          const handle = await agents.create({
            sessionId,
            meta: { cwd: params.cwd },
            agentOptions: agentOptions(config),
            signal: start.controller.signal,
          })
          /* v8 ignore next 4 -- a real stdio close can race the asynchronous agent factory. */
          if (closed) {
            await handle.dispose()
            throw internalError('connection closed during session/new')
          }
          const record = makeRecord(handle)
          sessions.set(sessionId, record)
          pendingCommandSnapshots.set(sessionId, record)
          return { sessionId }
        } finally {
          /* v8 ignore next -- this exact operation owns the map entry until its finally block. */
          if (startingSessions.get(sessionId) === start) startingSessions.delete(sessionId)
          start.finish()
        }
      },

      async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
        assertOpen()
        if (params.cursor !== undefined && params.cursor !== null) {
          throw invalidParams('session/list cursors are not supported')
        }
        if (params.cwd !== undefined && params.cwd !== null && !isAbsolute(params.cwd)) {
          throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
        }
        const records = (await ctx.sessionQuery.listSessions())
          .filter(record => record.header.cwd !== undefined
            && (params.cwd === undefined || params.cwd === null || record.header.cwd === params.cwd))
        const titleResults = await ctx.sessionQuery.readTitleSnapshots(records.map(record => record.header.id))
        const titles = new Map(titleResults.flatMap((result) => {
          if (result.status === 'rejected') {
            logger.warn(`acp-interactive: title read failed for session ${result.sessionId}: ${errorChain(result.reason)}`)
            return []
          }
          return result.value.title === undefined ? [] : [[result.sessionId, result.value.title.title] as const]
        }))
        return {
          sessions: records.map((record) => {
            const title = titles.get(record.header.id)
            return {
              sessionId: record.header.id,
              cwd: record.header.cwd as string,
              ...title === undefined ? {} : { title },
            }
          }),
        }
      },

      async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
        const { record, events } = await resumeRecord(params, true)
        for (const update of replayHistory(record, events)) notify(record, update)
        notifyCommands(record)
        await record.outputTail
        return {}
      },

      async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
        const { record } = await resumeRecord(params, false)
        notifyCommands(record)
        await record.outputTail
        return {}
      },

      async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
        assertOpen()
        const sessionId = SessionId(params.sessionId)
        const starting = startingSessions.get(sessionId)
        if (starting !== undefined) {
          starting.controller.abort(new Error('ACP session closed during restore'))
          await starting.done
        }
        const record = sessions.get(sessionId)
        if (record === undefined) {
          if (starting !== undefined) return {}
          throw invalidParams(`unknown session: ${sessionId}`)
        }
        await closeRecord(record)
        return {}
      },

      async prompt(params: PromptRequest): Promise<PromptResponse> {
        assertOpen()
        const record = requireSession(SessionId(params.sessionId))
        if (record.inflight !== undefined) throw invalidParams('a prompt is already in flight for this session')
        let content: ContentBlock[]
        try {
          content = admitTextPrompt(params.prompt)
        } catch (error: unknown) {
          /* v8 ignore next 2 -- the text admission codec throws only InteractivePromptError. */
          if (!(error instanceof InteractivePromptError)) throw error
          throw invalidParams(error.message)
        }
        const text = admittedText(content)
        if (text.startsWith('/')) {
          const completed = Promise.withResolvers<void>()
          const inflight: CommandInflight = {
            kind: 'command',
            controller: new AbortController(),
            cancelRequested: false,
            done: completed.promise,
            finish: () => { completed.resolve() },
          }
          record.inflight = inflight
          return runCommand(record, text, inflight)
        }

        if (agents.get(record.agent.id) !== record.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const completion = Promise.withResolvers<StopReason>()
        const message = createUserMessage({ content, source: { kind: 'user' } })
        const inflight: AgentInflight = {
          kind: 'agent',
          resolve: completion.resolve,
          reject: completion.reject,
          messageId: message.id,
          turn: undefined,
          endReason: undefined,
          agentError: undefined,
          cancelRequested: false,
          settlementStarted: false,
        }
        record.inflight = inflight
        try {
          record.agent.followup(message)
        } catch (error: unknown) {
          record.inflight = undefined
          throw internalError(`prompt was not queued: ${renderThrown(error)}`)
        }
        settleAfterQuiescence(record, inflight)
        return { stopReason: await completion.promise }
      },

      cancel(params: CancelNotification): Promise<void> {
        const record = sessions.get(SessionId(params.sessionId))
        if (record === undefined) return Promise.resolve()
        const inflight = record.inflight
        if (inflight?.kind === 'command') {
          inflight.cancelRequested = true
          inflight.controller.abort(new Error('ACP command cancelled'))
          return Promise.resolve()
        }
        if (inflight?.kind === 'agent') {
          inflight.cancelRequested = true
          record.agent.cancel({ kind: 'user' })
          settleAfterQuiescence(record, inflight)
        } else {
          record.agent.cancel({ kind: 'user' })
        }
        return Promise.resolve()
      },
    }
  }

  /* v8 ignore next 4 -- production stdio wiring; tests inject config.stream. */
  const baseStream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  conn = new AgentSideConnection(makeAgent, observeOutbound(baseStream, announceInitialCommands))

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    const starts = [...startingSessions.values()]
    for (const start of starts) start.controller.abort(new Error('interactive ACP bridge disposed'))
    const records = [...sessions.values()]
    sessions.clear()
    pendingCommandSnapshots.clear()
    const closing = records.flatMap(record => record.closing === undefined ? [] : [record.closing])
    const batch = records.filter(record => record.closing === undefined)
    for (const record of batch) cancelRecord(record, new Error('interactive ACP bridge disposed'))
    const batchClose = (async () => {
      await Promise.all([
        ...batch.map(record => awaitRecordIdle(record)),
      ])
      await drainDescendants(batch.map(record => record.agent))
      const results = await Promise.allSettled(batch.map(record => record.dispose()))
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
      if (failures.length > 0) {
        throw new AggregateError(failures, failures.map(failure => errorChain(failure)).join('; '))
      }
    })()
    for (const record of batch) record.closing = batchClose
    quiescing = (async () => {
      await Promise.all([...closing, batchClose, ...starts.map(start => start.done)])
    })()
    return quiescing
  }

  void conn.closed
    /* v8 ignore start -- the SDK resolves `closed` for input failures; this guard protects alternate Stream implementations. */
    .catch((error: unknown) => { logger.warn(`acp-interactive: connection closed with an error: ${String(error)}`) })
    /* v8 ignore stop */
    .then(quiesce)
    .catch((error: unknown) => { logger.warn(`acp-interactive: teardown failed: ${String(error)}`) })

  ctx.effect(() => quiesce, 'acp-interactive.connection')
}

function projectEvent(record: SessionRecord, event: SessionEvent): SessionNotification['update'][] {
  switch (event.type) {
    case 'assistant/chunk': {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta') {
        return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk.text } }]
      }
      if (chunk.type === 'reasoning-delta') {
        return [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: chunk.text } }]
      }
      if (chunk.type === 'usage') return projectUsage(record, event.data.turn, event.data.step, chunk.usage)
      return []
    }
    case 'assistant/message':
      return event.data.usage === undefined
        ? []
        : projectUsage(record, event.data.turn, event.data.step, event.data.usage)
    case 'tool/call': {
      const view = record.presenter.call(event.data.callId, event.data.name, event.data.arguments)
      return [projectToolCall(event.data.callId, view, record.terminal)]
    }
    case 'tool/result': {
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return []
      const block = event.data.message.content[0]
      const isError = block.isError === true
      const view = record.presenter.result(block.toolCallId, block.content, isError, event.data.meta)
      return [projectToolResult(block.toolCallId, view, isError, record.terminal)]
    }
    case 'todo/write':
      return [{ sessionUpdate: 'plan', ...todosToPlan(event.data.todos) }]
    case 'session/title':
      return [{
        sessionUpdate: 'session_info_update',
        title: event.data.title,
        updatedAt: new Date(event.time).toISOString(),
      }]
    case 'request/context': {
      record.usage.size = event.data.contextWindow
      return record.usage.size === undefined
        ? []
        : [{ sessionUpdate: 'usage_update', size: record.usage.size, used: record.usage.used }]
    }
    default:
      return []
  }
}

function replayHistory(record: SessionRecord, events: readonly SessionEvent[]): SessionNotification['update'][] {
  validateReplayableHistory(events)
  const updates: SessionNotification['update'][] = []
  let lastPlan: Extract<SessionEvent, { type: 'todo/write' }> | undefined
  let lastTitle: Extract<SessionEvent, { type: 'session/title' }> | undefined
  let lastContext: Extract<SessionEvent, { type: 'request/context' }> | undefined
  let lastUsage: Extract<SessionEvent, { type: 'assistant/message' }> | undefined

  for (const event of events) {
    switch (event.type) {
      case 'user/message':
        if (event.data.source.kind === 'user') {
          updates.push(...replayMessageContent('user_message_chunk', event.data.content))
        }
        break
      case 'assistant/message':
        updates.push(...replayMessageContent('agent_message_chunk', event.data.message.content))
        if (event.data.usage !== undefined) lastUsage = event
        break
      case 'tool/call':
      case 'tool/result':
        updates.push(...projectEvent(record, event))
        break
      case 'todo/write':
        lastPlan = event
        break
      case 'session/title':
        lastTitle = event
        break
      case 'request/context':
        lastContext = event
        break
      default:
        // Other durable events do not have an ACP history projection.
        break
    }
  }

  if (lastPlan !== undefined) {
    updates.push({ sessionUpdate: 'plan', ...todosToPlan(lastPlan.data.todos) })
  }
  if (lastTitle !== undefined) {
    updates.push({
      sessionUpdate: 'session_info_update',
      title: lastTitle.data.title,
      updatedAt: new Date(lastTitle.time).toISOString(),
    })
  }
  record.usage.size = lastContext?.data.contextWindow
  if (lastUsage?.data.usage !== undefined) {
    updates.push(...projectUsage(record, lastUsage.data.turn, lastUsage.data.step, lastUsage.data.usage))
  }
  return updates
}

function replayMessageContent(
  kind: 'user_message_chunk' | 'agent_message_chunk',
  content: readonly ContentBlock[],
): SessionNotification['update'][] {
  return content.flatMap((block): SessionNotification['update'][] => {
    switch (block.type) {
      case 'text':
        return [{ sessionUpdate: kind, content: { type: 'text', text: block.text } }]
      case 'reasoning':
        return kind === 'agent_message_chunk'
          ? [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: block.text } }]
          : (() => { throw new Error('unsupported restored user message content: reasoning') })()
      case 'tool-call':
      case 'tool-result':
        if (kind === 'user_message_chunk') {
          throw new Error(`unsupported restored user message content: ${block.type}`)
        }
        /* v8 ignore next -- assistant tool blocks are represented by their paired tool events. */
        return []
      case 'image':
        throw new Error('image content is not supported in restored session history')
      default:
        /* v8 ignore next -- merge-extensible content is refused; a first-party producer cannot create this branch. */
        throw new Error(`unsupported restored session content: ${(block as { type: string }).type}`)
    }
  })
}

function validateReplayableHistory(events: readonly SessionEvent[]): void {
  for (const event of events) {
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      replayMessageContent('user_message_chunk', event.data.content)
    } else if (event.type === 'assistant/message') {
      replayMessageContent('agent_message_chunk', event.data.message.content)
    } else if (event.type === 'tool/result') {
      const block = event.data.message.content[0]
      for (const content of block.content) {
        if (content.type !== 'text') {
          throw new Error(`unsupported restored tool result content: ${content.type}`)
        }
      }
    }
  }
}

function projectUsage(
  record: SessionRecord,
  turn: number,
  step: number,
  usage: TokenUsage,
): SessionNotification['update'][] {
  const used = usage.inputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
    + usage.outputTokens
  const sample = `${turn}:${step}:${used}`
  if (record.usage.lastSample === sample) return []
  record.usage.lastSample = sample
  record.usage.used = used
  return record.usage.size === undefined
    ? []
    : [{ sessionUpdate: 'usage_update', size: record.usage.size, used }]
}

/**
 * Map a whole harness todo list to ACP's replacement-plan form.
 * @param todos - current complete todo list.
 * @returns one medium-priority ACP entry per todo.
 */
export function todosToPlan(todos: readonly TodoItem[]): { entries: Array<{
  content: string
  priority: 'medium'
  status: TodoItem['status']
}> } {
  return {
    entries: todos.map(todo => ({
      content: todo.content,
      priority: 'medium',
      status: todo.status,
    })),
  }
}

function observeOutbound(stream: Stream, onWritten: (message: AnyMessage) => void): Stream {
  const writer = stream.writable.getWriter()
  return {
    readable: stream.readable,
    writable: new WritableStream<AnyMessage>({
      async write(message) {
        await writer.write(message)
        onWritten(message)
      },
      /* v8 ignore next -- AgentSideConnection does not close a caller-owned outbound stream. */
      close: () => writer.close(),
      /* v8 ignore next -- AgentSideConnection does not abort a caller-owned outbound stream. */
      abort: (reason: unknown) => writer.abort(reason),
    }),
  }
}

function responseSessionId(message: AnyMessage): SessionId | undefined {
  /* v8 ignore next 2 -- outbound SDK responses are generated from typed handlers; this is a defensive observer parser. */
  if (!('result' in message) || typeof message.result !== 'object' || message.result === null
    || !('sessionId' in message.result) || typeof message.result.sessionId !== 'string') return undefined
  return SessionId(message.result.sessionId)
}

function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

function renderThrown(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '<unrenderable thrown value>'
  }
}

function agentOptions(config: AcpInteractiveConfig): { provider?: string; model?: string } {
  return {
    ...config.provider === undefined ? {} : { provider: config.provider },
    ...config.model === undefined ? {} : { model: config.model },
  }
}

function validateSessionParams(params: NewSessionRequest): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported')
  }
  if (params.mcpServers.length > 0) throw invalidParams('mcpServers is not supported')
}

function validateRestoredSessionParams(params: LoadSessionRequest | ResumeSessionRequest): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported')
  }
  if (params.mcpServers !== undefined && params.mcpServers.length > 0) {
    throw invalidParams('mcpServers is not supported')
  }
}
