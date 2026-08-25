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
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
  type StopReason,
  type Stream,
} from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, errorChain, type ContentBlock, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type TodoItem, type TurnEndReason } from '@deepseek-ai/dsh-session'
// Declaration merges for the plugin-owned events and services projected below.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-title'
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
export const inject = ['agents', 'commands', 'tools']

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
  const pendingCommandSnapshots = new Map<SessionId, SessionRecord>()
  let closed = false
  let terminalOutputEnabled = false
  let conn: AgentSideConnection

  const assertOpen = (): void => {
    if (closed) throw internalError('the interactive ACP bridge has been disposed')
  }

  const requireSession = (sessionId: SessionId): SessionRecord => {
    const record = sessions.get(sessionId)
    if (record === undefined) throw invalidParams(`unknown session: ${sessionId}`)
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
      record.inflight = undefined
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
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
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
        const handle = await agents.create({
          sessionId,
          meta: { cwd: params.cwd },
          agentOptions: agentOptions(config),
        })
        /* v8 ignore next 4 -- a real stdio close can race the asynchronous agent factory. */
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/new')
        }
        const record: SessionRecord = {
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
        }
        sessions.set(sessionId, record)
        pendingCommandSnapshots.set(sessionId, record)
        return { sessionId }
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
          const inflight: CommandInflight = {
            kind: 'command',
            controller: new AbortController(),
            cancelRequested: false,
          }
          record.inflight = inflight
          return runCommand(record, text, inflight)
        }

        if (agents.get(record.agent.id) !== record.agent) {
          throw internalError('prompt was not queued: the agent was disposed outside the bridge')
        }
        const completion = promiseWithResolvers<StopReason>()
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
    const records = [...sessions.values()]
    sessions.clear()
    pendingCommandSnapshots.clear()
    for (const record of records) {
      const inflight = record.inflight
      if (inflight?.kind === 'command') {
        inflight.cancelRequested = true
        inflight.controller.abort(new Error('interactive ACP bridge disposed'))
      } else if (inflight?.kind === 'agent') {
        inflight.cancelRequested = true
        settleAfterQuiescence(record, inflight)
      }
      record.agent.cancel({ kind: 'user' })
    }
    quiescing = (async () => {
      await Promise.all(records.map(async (record) => {
        await record.agent.whenIdle()
        await record.outputTail
      }))
      const subagents = ctx.get('subagents') as ContinuableDrain | undefined
      if (subagents !== undefined) {
        try {
          await subagents.drainContinuableDescendants(records.map(record => record.agent))
        } catch (error: unknown) {
          logger.warn(`acp-interactive: continuable subagent teardown failed: ${String(error)}`)
        }
      }
      const results = await Promise.allSettled(records.map(record => record.dispose()))
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
      if (failures.length > 0) {
        throw new AggregateError(failures, failures.map(failure => errorChain(failure)).join('; '))
      }
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

function promiseWithResolvers<T>(): {
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

function agentOptions(config: AcpInteractiveConfig): { provider?: string; model?: string } {
  return {
    ...config.provider === undefined ? {} : { provider: config.provider },
    ...config.model === undefined ? {} : { model: config.model },
  }
}

function validateSessionParams(params: NewSessionRequest): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported in phase one')
  }
  if (params.mcpServers.length > 0) throw invalidParams('mcpServers is not supported in phase one')
}
