/**
 * Interactive Agent Client Protocol server for editor-hosted dsh sessions.
 *
 * The plugin projects the durable session stream onto ACP UI updates while the
 * harness retains ownership of model calls, tools, permissions, and teardown.
 * @module dsh-acp-interactive
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AgentConnection,
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
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionConfigOption,
  type SessionModeState,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason,
  type Stream,
} from '@agentclientprotocol/sdk'
import {
  installModelSelection,
  type Agent,
  type AgentHandle,
  type ModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage, errorChain, type ContentBlock, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session'
// Declaration merges for the plugin-owned events and services projected below.
// `dsh-tool-todo` now owns both the `todo/write` session event and `TodoItem`.
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-tools'
import { isUserInvocable } from '@deepseek-ai/dsh-skill'
import { assertRouteCredential, assertSessionCredential, authMethodsFor } from './auth.js'
import { admitPrompt, admittedCommandText, InteractivePromptError, projectImage } from './content.js'
import { turnEndToStopReason } from './codec.js'
import {
  decodeModelValue,
  decodeReasoningValue,
  hasModelValue,
  hasReasoningValue,
  MODEL_CONFIG_ID,
  PERMISSION_CONFIG_ID,
  REASONING_CONFIG_ID,
  permissionDirectory,
  sessionConfigOptions,
} from './config-options.js'
import { acpQuestionAnswerer } from './elicitation.js'
import {
  DEFAULT_MODE_ID,
  PLAN_MODE_ID,
  planModeDirectory,
  sessionModes,
} from './modes.js'
import {
  projectToolCall,
  projectToolResult,
  ToolPresenter,
  type TerminalRendering,
} from './presentation.js'
import {
  installSessionMcp,
  mapMcpServers,
  McpConfigError,
  type SessionMcpHandle,
} from './mcp.js'

/** Registry id, executable name, and ACP agent name are one identifier. */
const AGENT_NAME = 'dsh-acp-interactive'
const PACKAGE_VERSION = (JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string }).version

export const name = 'acp-interactive'
/** Interactive UI registries; concrete model, skill, and tool providers remain composition choices. */
export const inject = [
  'agents',
  'commands',
  'llm',
  'skills',
  'tools',
  'sessions',
  'sessionPersistence',
  'sessionQuery',
]

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

interface AdmissionInflight {
  kind: 'admission'
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
  selection: ModelSelectionRef
  presenter: ToolPresenter
  terminal: TerminalRendering
  outputTail: Promise<void>
  usage: UsageState
  inflight: AgentInflight | CommandInflight | AdmissionInflight | undefined
  closing: Promise<void> | undefined
  configTail: Promise<void>
  configuring: number
  mode: string | undefined
  skillCommands: AvailableCommand[]
  commandCatalogController: AbortController | undefined
  mcp: SessionMcpHandle
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

interface BridgeHandlers {
  initialize(params: InitializeRequest): Promise<InitializeResponse>
  authenticate(params: AuthenticateRequest): Promise<void>
  newSession(params: NewSessionRequest, signal: AbortSignal): Promise<NewSessionResponse>
  listSessions(params: ListSessionsRequest, signal: AbortSignal): Promise<ListSessionsResponse>
  loadSession(params: LoadSessionRequest, signal: AbortSignal): Promise<LoadSessionResponse>
  resumeSession(params: ResumeSessionRequest, signal: AbortSignal): Promise<ResumeSessionResponse>
  closeSession(params: CloseSessionRequest, signal: AbortSignal): Promise<CloseSessionResponse>
  setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
    signal: AbortSignal,
  ): Promise<SetSessionConfigOptionResponse>
  setSessionMode(params: SetSessionModeRequest, signal: AbortSignal): Promise<SetSessionModeResponse>
  prompt(params: PromptRequest, signal: AbortSignal): Promise<PromptResponse>
  cancel(params: CancelNotification): Promise<void>
}

/**
 * Mount the editor-facing ACP server.
 * @param ctx - Cordis context carrying the agent, command, skill, and tool registries.
 * @param config - provider/model defaults and optional test transport.
 */
export function apply(ctx: Context, config: AcpInteractiveConfig): void {
  const agents = ctx.agents
  const commands = ctx.commands
  const skills = ctx.skills
  const tools = ctx.tools
  const logger = ctx.logger
  const sessions = new Map<SessionId, SessionRecord>()
  const startingSessions = new Map<SessionId, StartOperation>()
  const pendingCommandSnapshots = new Map<SessionId, SessionRecord>()
  const selections = new WeakMap<Agent, ModelSelectionRef>()
  const sessionMcp = new WeakMap<Agent, SessionMcpHandle>()
  let closed = false
  let terminalOutputEnabled = false
  let imagePromptEnabled = false
  let elicitationEnabled = false
  let booleanConfigEnabled = false
  let conn: AgentConnection
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
    const delivery = record.outputTail.then(() => conn.client.notify(
      methods.client.session.update,
      { sessionId: record.agent.session.id, update },
    ))
    /* v8 ignore start -- The SDK contains notification transport failures; this protects alternate Stream implementations. */
    record.outputTail = delivery.catch((error: unknown) => {
      logger.warn(`acp-interactive: session/update failed: ${String(error)}`)
    })
    /* v8 ignore stop */
  }

  const notifyImage = (
    record: SessionRecord,
    sessionUpdate: 'agent_message_chunk' | 'user_message_chunk',
    block: Extract<ContentBlock, { type: 'image' }>,
    messageId: string,
  ): void => {
    const delivery = record.outputTail.then(async () => {
      const content = await projectImage(ctx, block.attachment)
      await conn.client.notify(methods.client.session.update, {
        sessionId: record.agent.session.id,
        update: { sessionUpdate, content, messageId },
      })
    })
    record.outputTail = delivery.catch((error: unknown) => {
      logger.warn(`acp-interactive: image projection failed: ${errorChain(error)}`)
    })
  }

  const availableCommands = (record: SessionRecord): AvailableCommand[] => {
    const commandEntries = commands.list(record.agent).map(command => ({
      name: command.name,
      description: command.description,
      ...command.input === undefined ? {} : { input: { hint: command.input.hint } },
    }))
    const commandNames = new Set(commandEntries.map(command => command.name))
    return [...commandEntries, ...record.skillCommands.filter(skill => !commandNames.has(skill.name))]
      // Names are unique after command precedence removes collisions.
      .sort((left, right) => left.name < right.name ? -1 : 1)
  }

  const notifyCommands = (record: SessionRecord): void => {
    notify(record, {
      sessionUpdate: 'available_commands_update',
      availableCommands: availableCommands(record),
    })
  }

  const listSkillCommands = async (record: SessionRecord, signal: AbortSignal): Promise<AvailableCommand[] | undefined> => {
    const snapshot = await skills.snapshot({
      cwd: record.agent.session.header.cwd,
      scope: record.agent,
      signal,
    })
    if (!snapshot.complete) return undefined
    return snapshot.skills.filter(isUserInvocable).map(skill => ({
      name: skill.name,
      description: skill.description,
    }))
  }

  const refreshCommands = async (record: SessionRecord): Promise<void> => {
    record.commandCatalogController?.abort(new Error('ACP command catalog refresh replaced'))
    const controller = new AbortController()
    record.commandCatalogController = controller
    try {
      const skillCommands = await listSkillCommands(record, controller.signal)
      if (skillCommands !== undefined) record.skillCommands = skillCommands
    } catch (error: unknown) {
      if (controller.signal.aborted) return
      logger.warn(`acp-interactive: command catalog refresh failed: ${errorChain(error)}`)
    } finally {
      if (record.commandCatalogController === controller) record.commandCatalogController = undefined
    }
    if (sessions.get(record.agent.session.id) !== record || record.closing !== undefined) return
    notifyCommands(record)
  }

  const selectionFor = (agent: Agent): ModelSelectionRef => {
    const selection = selections.get(agent)
    /* v8 ignore next -- every bridge create/resume installs the selection in its unpublished setup. */
    if (selection === undefined) throw new Error('acp-interactive: agent model selection was not installed during setup')
    return selection
  }

  const installSelection = (agentCtx: Context): void => {
    const agent = agentCtx.agent
    /* v8 ignore next -- AgentRegistry setup always receives the new agent's scoped context. */
    if (agent === undefined) throw new Error('acp-interactive: agent setup has no scoped agent')
    let picked: ModelSelection | undefined
    const selection: ModelSelectionRef = {
      get current(): ModelSelection | undefined {
        if (picked !== undefined) return picked
        const logged = agent.session.requestHeader()?.config
        if (logged !== undefined) {
          return {
            provider: logged.provider,
            model: logged.model,
            ...logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort },
          }
        }
        return agent.options.provider === undefined || agent.options.model === undefined
          ? undefined
          : { provider: agent.options.provider, model: agent.options.model }
      },
      set current(next: ModelSelection | undefined) {
        picked = next
      },
      assembled: undefined,
    }
    installModelSelection(agentCtx, selection)
    selections.set(agent, selection)
  }

  const installSessionSetup = (
    mcpConfigs: ReturnType<typeof mapMcpServers>,
    signal: AbortSignal,
  ) => async (agentCtx: Context): Promise<void> => {
    installSelection(agentCtx)
    const agent = agentCtx.agent
    /* v8 ignore next -- AgentRegistry setup always receives the new agent's scoped context. */
    if (agent === undefined) throw new Error('acp-interactive: agent setup has no scoped agent')
    const mcp = await installSessionMcp(agentCtx, mcpConfigs, signal)
    sessionMcp.set(agent, mcp)
  }

  const validateMcpServers = (servers: readonly McpServer[], cwd: string): ReturnType<typeof mapMcpServers> => {
    try {
      return mapMcpServers(servers, cwd)
    } catch (error: unknown) {
      // mapMcpServers owns this validation boundary and throws only McpConfigError.
      throw invalidParams((error as McpConfigError).message)
    }
  }

  const makeRecord = (handle: AgentHandle): SessionRecord => ({
    agent: handle.agent,
    dispose: () => handle.dispose(),
    selection: selectionFor(handle.agent),
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
    configTail: Promise.resolve(),
    configuring: 0,
    mode: undefined,
    skillCommands: [],
    commandCatalogController: undefined,
    mcp: sessionMcp.get(handle.agent) as SessionMcpHandle,
  })

  const configOptions = async (record: SessionRecord): Promise<SessionConfigOption[]> => {
    const options = await sessionConfigOptions(ctx, record.agent, record.selection.current)
    return booleanConfigEnabled ? options : options.filter(option => option.type !== 'boolean')
  }

  const modeState = (record: SessionRecord): SessionModeState | undefined => {
    const modes = sessionModes(ctx, record.agent)
    if (modes !== undefined) record.mode = modes.currentModeId
    return modes
  }

  const notifyMode = (record: SessionRecord, currentModeId: string): void => {
    if (record.mode === currentModeId) return
    record.mode = currentModeId
    notify(record, { sessionUpdate: 'current_mode_update', currentModeId })
  }

  const queueConfig = <T>(record: SessionRecord, operation: () => Promise<T>): Promise<T> => {
    const result = record.configTail.then(operation)
    record.configTail = result.then(() => undefined, () => undefined)
    return result
  }

  const notifyConfigOptions = (record: SessionRecord): void => {
    void queueConfig(record, async () => {
      const options = await configOptions(record)
      notify(record, { sessionUpdate: 'config_option_update', configOptions: options })
    }).catch((error: unknown) => {
      logger.warn(`acp-interactive: config option refresh failed: ${errorChain(error)}`)
    })
  }

  const serializeConfig = <T>(record: SessionRecord, operation: () => Promise<T>): Promise<T> => {
    record.configuring += 1
    return queueConfig(record, operation).finally(() => {
      record.configuring -= 1
    })
  }

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
    record.commandCatalogController?.abort(reason)
    const inflight = record.inflight
    if (inflight?.kind === 'admission' || inflight?.kind === 'command') {
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
    if (inflight?.kind === 'admission' || inflight?.kind === 'command') await inflight.done
    await record.agent.whenIdle()
    await record.configTail
    await record.outputTail
  }

  const closeRecord = (record: SessionRecord): Promise<void> => {
    if (record.closing !== undefined) return record.closing
    const sessionId = record.agent.session.id
    record.closing = (async () => {
      cancelRecord(record, new Error('ACP session closed'))
      await awaitRecordIdle(record)
      await drainDescendants([record.agent])
      let checkpointError: unknown
      try {
        await ctx.sessions.flush(record.agent.session)
      } catch (error: unknown) {
        checkpointError = error
      }
      await disposeRecord(record)
      if (checkpointError !== undefined) throw checkpointError
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
    signal: AbortSignal,
  ): Promise<{ record: SessionRecord; events: readonly SessionEvent[] }> => {
    assertOpen()
    signal.throwIfAborted()
    validateRestoredSessionParams(params)
    const mcpConfigs = validateMcpServers(params.mcpServers ?? [], params.cwd)
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
      signal.throwIfAborted()
      if (snapshot.session.cwd === undefined) {
        throw invalidParams(`session has no recorded cwd: ${sessionId}`)
      }
      if (snapshot.session.cwd !== params.cwd) {
        throw invalidParams(`cwd does not match session ${sessionId}: expected ${snapshot.session.cwd}`)
      }
      if (replay) validateReplayableHistory(snapshot.events)
      const operationSignal = AbortSignal.any([start.controller.signal, signal])
      const handle = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: agentOptions(config),
        signal: operationSignal,
        setup: installSessionSetup(mcpConfigs, operationSignal),
      })
      if (closed || operationSignal.aborted) {
        await handle.dispose()
        operationSignal.throwIfAborted()
        throw internalError('connection closed during session restore')
      }
      const record = makeRecord(handle)
      sessions.set(sessionId, record)
      return { record, events: snapshot.events }
    } catch (error: unknown) {
      signal.throwIfAborted()
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
    void refreshCommands(record)
  }

  ctx.on('commands/change', () => {
    for (const record of sessions.values()) {
      if (!pendingCommandSnapshots.has(record.agent.session.id)) notifyCommands(record)
    }
  })

  ctx.on('skills/change', () => {
    for (const record of sessions.values()) {
      if (pendingCommandSnapshots.has(record.agent.session.id)) continue
      void refreshCommands(record)
    }
  })

  ctx.on('llm/adapters-updated', () => {
    for (const record of sessions.values()) notifyConfigOptions(record)
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
      if (event.type === 'assistant/message') {
        for (const block of event.data.message.content) {
          if (block.type === 'image') {
            notifyImage(
              record,
              'agent_message_chunk',
              block,
              assistantMessageId(record.agent.session.id, event.data.turn, event.data.step),
            )
          }
        }
      }
      if (event.type === 'plan/mode') {
        notifyMode(record, event.data.active ? PLAN_MODE_ID : DEFAULT_MODE_ID)
      }
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
    return conn.client.request(
      methods.client.session.requestPermission,
      {
      sessionId: record.agent.session.id,
      toolCall: { toolCallId: request.callId },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
      },
      request.signal === undefined ? undefined : { cancellationSignal: request.signal },
    ).then(({ outcome }) => {
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
      const execution = await commands.execute(record.agent, text, [], inflight.controller.signal)
      const rendered = execution === undefined
        ? `Error: unknown command: ${text}`
        : execution.result.kind === 'error'
          ? `Error: ${execution.result.text}`
          : execution.result.text
      if (rendered !== undefined && rendered.length > 0) {
        notify(record, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: rendered },
          messageId: `command:${randomUUID()}`,
        })
        await record.outputTail
      }
      return { stopReason: 'end_turn' }
    } catch (error: unknown) {
      if (inflight.cancelRequested || inflight.controller.signal.aborted) return { stopReason: 'cancelled' }
      notify(record, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `Error: command failed: ${renderThrown(error)}` },
        messageId: `command:${randomUUID()}`,
      })
      await record.outputTail
      return { stopReason: 'end_turn' }
    } finally {
      /* v8 ignore next -- this command owns the slot until its own finally block. */
      if (record.inflight === inflight) record.inflight = undefined
      inflight.finish()
    }
  }

  const makeAgent = (): BridgeHandlers => {
    return {
      initialize(params: InitializeRequest): Promise<InitializeResponse> {
        terminalOutputEnabled = params.clientCapabilities?._meta?.['terminal_output'] === true
        imagePromptEnabled = ctx.get('attachments') !== undefined
        elicitationEnabled = params.clientCapabilities?.elicitation?.form !== undefined
          && params.clientCapabilities.elicitation.form !== null
        booleanConfigEnabled = params.clientCapabilities?.session?.configOptions?.boolean !== undefined
          && params.clientCapabilities.session.configOptions.boolean !== null
        return Promise.resolve({
          protocolVersion: PROTOCOL_VERSION,
          agentInfo: { name: AGENT_NAME, version: PACKAGE_VERSION },
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: imagePromptEnabled, audio: false, embeddedContext: false },
            mcpCapabilities: { http: true },
            sessionCapabilities: {
              list: {},
              resume: {},
              close: {},
            },
          },
          authMethods: authMethodsFor(params.clientCapabilities),
        })
      },

      authenticate(_params: AuthenticateRequest): Promise<void> {
        return Promise.resolve()
      },

      async newSession(params: NewSessionRequest, signal: AbortSignal): Promise<NewSessionResponse> {
        assertOpen()
        validateSessionParams(params)
        const mcpConfigs = validateMcpServers(params.mcpServers, params.cwd)
        await assertSessionCredential(ctx, config, signal)
        signal.throwIfAborted()
        const sessionId = SessionId(randomUUID())
        const settled = Promise.withResolvers<void>()
        const start: StartOperation = {
          controller: new AbortController(),
          done: settled.promise,
          finish: () => { settled.resolve() },
        }
        startingSessions.set(sessionId, start)
        try {
          const operationSignal = AbortSignal.any([start.controller.signal, signal])
          let handle: AgentHandle
          try {
            handle = await agents.create({
              sessionId,
              meta: { cwd: params.cwd },
              agentOptions: agentOptions(config),
              signal: operationSignal,
              setup: installSessionSetup(mcpConfigs, operationSignal),
            })
          } catch (error: unknown) {
            signal.throwIfAborted()
            throw internalError(`session creation failed: ${errorChain(error)}`)
          }
          /* v8 ignore next 4 -- a real stdio close can race the asynchronous agent factory. */
          if (closed || operationSignal.aborted) {
            await handle.dispose()
            operationSignal.throwIfAborted()
            throw internalError('connection closed during session/new')
          }
          const record = makeRecord(handle)
          sessions.set(sessionId, record)
          pendingCommandSnapshots.set(sessionId, record)
          try {
            const modes = modeState(record)
            return {
              sessionId,
              configOptions: await serializeConfig(record, () => configOptions(record)),
              ...modes === undefined ? {} : { modes },
            }
          } catch (error: unknown) {
            await closeRecord(record)
            throw internalError(`session creation failed: ${errorChain(error)}`)
          }
        } finally {
          /* v8 ignore next -- this exact operation owns the map entry until its finally block. */
          if (startingSessions.get(sessionId) === start) startingSessions.delete(sessionId)
          start.finish()
        }
      },

      async listSessions(params: ListSessionsRequest, signal: AbortSignal): Promise<ListSessionsResponse> {
        assertOpen()
        if (params.cursor !== undefined && params.cursor !== null) {
          throw invalidParams('session/list cursors are not supported')
        }
        if (params.cwd !== undefined && params.cwd !== null && !isAbsolute(params.cwd)) {
          throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
        }
        const records = (await ctx.sessionQuery.listSessions(signal))
          .filter(record => record.header.cwd !== undefined
            && (params.cwd === undefined || params.cwd === null || record.header.cwd === params.cwd))
        const titleResults = await ctx.sessionQuery.readTitleSnapshots(records.map(record => record.header.id))
        signal.throwIfAborted()
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

      async loadSession(params: LoadSessionRequest, signal: AbortSignal): Promise<LoadSessionResponse> {
        const { record, events } = await resumeRecord(params, true, signal)
        try {
          const initialConfig = serializeConfig(record, () => configOptions(record))
          for (const update of await replayHistory(ctx, record, events)) notify(record, update)
          await refreshCommands(record)
          const [options] = await Promise.all([initialConfig, record.outputTail])
          const modes = modeState(record)
          return { configOptions: options, ...modes === undefined ? {} : { modes } }
        } catch (error: unknown) {
          await closeRecord(record)
          throw internalError(`session history projection failed: ${errorChain(error)}`)
        }
      },

      async resumeSession(params: ResumeSessionRequest, signal: AbortSignal): Promise<ResumeSessionResponse> {
        const { record } = await resumeRecord(params, false, signal)
        try {
          const initialConfig = serializeConfig(record, () => configOptions(record))
          await refreshCommands(record)
          const [options] = await Promise.all([initialConfig, record.outputTail])
          const modes = modeState(record)
          return { configOptions: options, ...modes === undefined ? {} : { modes } }
        } catch (error: unknown) {
          await closeRecord(record)
          throw internalError(`session resume failed: ${errorChain(error)}`)
        }
      },

      async closeSession(params: CloseSessionRequest, signal: AbortSignal): Promise<CloseSessionResponse> {
        assertOpen()
        signal.throwIfAborted()
        const sessionId = SessionId(params.sessionId)
        const starting = startingSessions.get(sessionId)
        if (starting !== undefined) {
          starting.controller.abort(new Error('ACP session closed during restore'))
          await starting.done
          signal.throwIfAborted()
        }
        const record = sessions.get(sessionId)
        if (record === undefined) {
          if (starting !== undefined) return {}
          throw invalidParams(`unknown session: ${sessionId}`)
        }
        await closeRecord(record)
        signal.throwIfAborted()
        return {}
      },

      setSessionConfigOption(
        params: SetSessionConfigOptionRequest,
        signal: AbortSignal,
      ): Promise<SetSessionConfigOptionResponse> {
        assertOpen()
        signal.throwIfAborted()
        const record = requireSession(SessionId(params.sessionId))
        return serializeConfig(record, async () => {
          signal.throwIfAborted()
          /* v8 ignore next -- a close racing after requireSession is a defensive cross-request guard. */
          if (record.closing !== undefined) throw invalidParams(`session is closing: ${record.agent.session.id}`)
          if (params.configId === MODEL_CONFIG_ID) {
            if (typeof params.value !== 'string') throw invalidParams('model configuration requires a select value')
            const available = await configOptions(record)
            if (!hasModelValue(available, params.value)) throw invalidParams(`unknown model selection: ${params.value}`)
            let route: { provider: string; model: string }
            try {
              route = decodeModelValue(params.value)
            } catch (error: unknown) {
              /* v8 ignore next -- advertised model values are emitted only by encodeModelValue(). */
              throw invalidParams(error instanceof Error ? error.message : String(error))
            }
            try {
              const resolved = await ctx.llm.resolveCallConfig(route)
              signal.throwIfAborted()
              record.selection.current = {
                provider: resolved.provider,
                model: resolved.model,
              }
            } catch (error: unknown) {
              throw invalidParams(`model is unavailable: ${errorChain(error)}`)
            }
          } else if (params.configId === REASONING_CONFIG_ID) {
            if (typeof params.value !== 'string') throw invalidParams('reasoning configuration requires a select value')
            const available = await configOptions(record)
            if (!hasReasoningValue(available, params.value)) {
              throw invalidParams(`unknown reasoning effort: ${params.value}`)
            }
            const current = record.selection.current
            /* v8 ignore next -- without a current route, configOptions advertises no reasoning selector. */
            if (current === undefined) throw invalidParams('reasoning configuration has no current model route')
            let reasoningEffort: ReturnType<typeof decodeReasoningValue>
            try {
              reasoningEffort = decodeReasoningValue(params.value)
            } catch (error: unknown) {
              /* v8 ignore next -- advertised values are emitted by config-options.ts. */
              throw invalidParams(error instanceof Error ? error.message : String(error))
            }
            try {
              await ctx.llm.resolveCallConfig({
                provider: current.provider,
                model: current.model,
                ...reasoningEffort === undefined ? {} : { reasoningEffort },
              })
              signal.throwIfAborted()
              record.selection.current = {
                provider: current.provider,
                model: current.model,
                ...reasoningEffort === undefined ? {} : { reasoningEffort },
              }
            } catch (error: unknown) {
              throw invalidParams(`reasoning effort is unavailable: ${errorChain(error)}`)
            }
          } else if (params.configId === PERMISSION_CONFIG_ID) {
            if (typeof params.value !== 'string') throw invalidParams('permission configuration requires a select value')
            const permissions = permissionDirectory(ctx)
            if (permissions === undefined) throw invalidParams('permission configuration is unavailable')
            if (!permissions.names.includes(params.value)) {
              throw invalidParams(`unknown permission preset: ${params.value}`)
            }
            // A running session accepts the switch: the preset events commit to the
            // durable log immediately and take effect on the next confined call and
            // approval request, so the editor permission selector works at any time.
            const controller = new AbortController()
            const executionSignal = AbortSignal.any([controller.signal, signal])
            const execution = await commands.execute(
              record.agent,
              `/permission ${params.value}`,
              [],
              executionSignal,
            )
            signal.throwIfAborted()
            if (execution === undefined) throw internalError('permission command is unavailable')
            if (execution.result.kind === 'error') throw invalidParams(execution.result.text)
            notifyConfigOptions(record)
          } else {
            throw invalidParams(`unknown session configuration option: ${params.configId}`)
          }
          return { configOptions: await configOptions(record) }
        })
      },

      async setSessionMode(params: SetSessionModeRequest, signal: AbortSignal): Promise<SetSessionModeResponse> {
        assertOpen()
        signal.throwIfAborted()
        const record = requireSession(SessionId(params.sessionId))
        const planMode = planModeDirectory(ctx)
        if (planMode === undefined) throw invalidParams('session modes are unavailable')
        if (params.modeId !== DEFAULT_MODE_ID && params.modeId !== PLAN_MODE_ID) {
          throw invalidParams(`unknown session mode: ${params.modeId}`)
        }
        planMode.set(record.agent, params.modeId === PLAN_MODE_ID)
        notifyMode(record, params.modeId)
        await record.outputTail
        signal.throwIfAborted()
        return {}
      },

      async prompt(params: PromptRequest, signal: AbortSignal): Promise<PromptResponse> {
        assertOpen()
        signal.throwIfAborted()
        const record = requireSession(SessionId(params.sessionId))
        if (record.configuring > 0) throw invalidParams('a session configuration change is in flight')
        if (record.inflight !== undefined) throw invalidParams('a prompt is already in flight for this session')
        const admissionDone = Promise.withResolvers<void>()
        const admission: AdmissionInflight = {
          kind: 'admission',
          controller: new AbortController(),
          cancelRequested: false,
          done: admissionDone.promise,
          finish: () => { admissionDone.resolve() },
        }
        record.inflight = admission
        const requestAborted = (): void => {
          const current = record.inflight
          if (current?.kind === 'admission' || current?.kind === 'command') {
            current.cancelRequested = true
            current.controller.abort(signal.reason)
          } else {
            /* The listener is removed before this exact prompt releases its inflight slot. */
            const agentInflight = current as AgentInflight
            agentInflight.cancelRequested = true
            record.agent.cancel({ kind: 'user' })
            settleAfterQuiescence(record, agentInflight)
          }
        }
        signal.addEventListener('abort', requestAborted, { once: true })
        /* v8 ignore next -- the SDK invokes a request handler before a later cancellation notification can run. */
        if (signal.aborted) requestAborted()
        try {
        let content: ContentBlock[]
        let commandText: string | undefined
        let dispatchCommand = false
        try {
          content = await admitPrompt(
            ctx,
            record.agent,
            record.selection.current,
            params.prompt,
            imagePromptEnabled,
            admission.controller.signal,
          )
          commandText = admittedCommandText(params.prompt, content)
          if (commandText?.startsWith('/') === true) {
            const parsed = parseCommand(commandText)
            const command = parsed === undefined ? undefined : commands.find(record.agent, parsed.name)
            if (command !== undefined) {
              dispatchCommand = true
            } else {
              const skill = parsed === undefined ? undefined : await skills.get(parsed.name, {
                cwd: record.agent.session.header.cwd,
                scope: record.agent,
                signal: admission.controller.signal,
              })
              dispatchCommand = skill === undefined || !isUserInvocable(skill)
            }
          }
          // A model turn on the official DeepSeek route without a key is answered
          // with auth_required here rather than as a model-call failure later.
          if (!dispatchCommand) {
            await assertRouteCredential(ctx, record.selection.current?.provider, admission.controller.signal)
          }
        } catch (error: unknown) {
          if (admission.cancelRequested || admission.controller.signal.aborted) {
            await record.mcp.dispose()
            return { stopReason: 'cancelled' }
          }
          /* v8 ignore next -- admitPrompt contains non-abort failures as InteractivePromptError. */
          if (!(error instanceof InteractivePromptError)) throw error
          throw error.kind === 'invalid' ? invalidParams(error.message) : internalError(error.message)
        } finally {
          admission.finish()
          /* v8 ignore next -- admission remains installed until this finally block; close only cancels it. */
          if (record.inflight === admission) record.inflight = undefined
        }
        if (dispatchCommand && commandText !== undefined) {
          const completed = Promise.withResolvers<void>()
          const inflight: CommandInflight = {
            kind: 'command',
            controller: new AbortController(),
            cancelRequested: false,
            done: completed.promise,
            finish: () => { completed.resolve() },
          }
          record.inflight = inflight
          const response = await runCommand(record, commandText, inflight)
          if (response.stopReason === 'cancelled') await record.mcp.dispose()
          notifyConfigOptions(record)
          return response
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
        const stopReason = await completion.promise
        if (stopReason === 'cancelled') await record.mcp.dispose()
        return { stopReason }
        } finally {
          signal.removeEventListener('abort', requestAborted)
        }
      },

      async cancel(params: CancelNotification): Promise<void> {
        const record = sessions.get(SessionId(params.sessionId))
        if (record === undefined) return
        const inflight = record.inflight
        if (inflight?.kind === 'admission' || inflight?.kind === 'command') {
          inflight.cancelRequested = true
          inflight.controller.abort(new Error('ACP command cancelled'))
          await inflight.done
          await record.mcp.dispose()
          return
        }
        if (inflight?.kind === 'agent') {
          inflight.cancelRequested = true
          record.agent.cancel({ kind: 'user' })
          settleAfterQuiescence(record, inflight)
        } else {
          record.agent.cancel({ kind: 'user' })
        }
        await record.agent.whenIdle()
        await record.outputTail
        await record.mcp.dispose()
      },
    }
  }

  /* v8 ignore next 4 -- production stdio wiring; tests inject config.stream. */
  const baseStream: Stream = config.stream ?? ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  )
  const handlers = makeAgent()
  const app = agent({ name: AGENT_NAME })
    .onRequest(methods.agent.initialize, ({ params }) => handlers.initialize(params))
    .onRequest(methods.agent.authenticate, ({ params }) => handlers.authenticate(params))
    .onRequest(methods.agent.session.new, ({ params, signal }) => handlers.newSession(params, signal))
    .onRequest(methods.agent.session.list, ({ params, signal }) => handlers.listSessions(params, signal))
    .onRequest(methods.agent.session.load, ({ params, signal }) => handlers.loadSession(params, signal))
    .onRequest(methods.agent.session.resume, ({ params, signal }) => handlers.resumeSession(params, signal))
    .onRequest(methods.agent.session.close, ({ params, signal }) => handlers.closeSession(params, signal))
    .onRequest(methods.agent.session.setConfigOption, ({ params, signal }) => (
      handlers.setSessionConfigOption(params, signal)
    ))
    .onRequest(methods.agent.session.setMode, ({ params, signal }) => handlers.setSessionMode(params, signal))
    .onRequest(methods.agent.session.prompt, ({ params, signal }) => handlers.prompt(params, signal))
    .onNotification(methods.agent.session.cancel, ({ params }) => handlers.cancel(params))
  conn = app.connect(observeOutbound(baseStream, announceInitialCommands))

  ctx.on('user-questions/request', acpQuestionAnswerer(
    (request) => {
      if (request.agent === undefined) return undefined
      return ownedRecord(request.agent)?.agent.session.id
    },
    () => elicitationEnabled,
    (request, options) => conn.client.request(methods.client.elicitation.create, request, options),
  ))

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
      const results = await Promise.allSettled(batch.map(disposeRecord))
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

  conn.signal.addEventListener('abort', () => {
    void quiesce().catch((error: unknown) => {
      logger.warn(`acp-interactive: teardown failed: ${String(error)}`)
    })
  }, { once: true })

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
      const messageId = assistantMessageId(record.agent.session.id, event.data.turn, event.data.step)
      if (chunk.type === 'text-delta') {
        return [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk.text }, messageId }]
      }
      if (chunk.type === 'reasoning-delta') {
        return [{
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: chunk.text },
          messageId: thoughtMessageId(messageId),
        }]
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

async function replayHistory(
  ctx: Context,
  record: SessionRecord,
  events: readonly SessionEvent[],
): Promise<SessionNotification['update'][]> {
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
          updates.push(...await replayMessageContent(ctx, 'user_message_chunk', event.data.content, event.data.id))
        }
        break
      case 'assistant/message':
        updates.push(...await replayMessageContent(
          ctx,
          'agent_message_chunk',
          event.data.message.content,
          assistantMessageId(record.agent.session.id, event.data.turn, event.data.step),
        ))
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

async function replayMessageContent(
  ctx: Context,
  kind: 'user_message_chunk' | 'agent_message_chunk',
  content: readonly ContentBlock[],
  messageId: string,
): Promise<SessionNotification['update'][]> {
  const updates: SessionNotification['update'][] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        updates.push({ sessionUpdate: kind, content: { type: 'text', text: block.text }, messageId })
        break
      case 'reasoning':
        /* v8 ignore next -- validateReplayableHistory rejects reasoning in a user message first. */
        if (kind !== 'agent_message_chunk') throw new Error('unsupported restored user message content: reasoning')
        updates.push({
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: block.text },
          messageId: thoughtMessageId(messageId),
        })
        break
      case 'tool-call':
      case 'tool-result':
        /* v8 ignore next 3 -- validateReplayableHistory rejects tool blocks in a user message first. */
        if (kind === 'user_message_chunk') {
          throw new Error(`unsupported restored user message content: ${block.type}`)
        }
        /* v8 ignore next -- assistant tool blocks are represented by their paired tool events. */
        break
      case 'image':
        updates.push({ sessionUpdate: kind, content: await projectImage(ctx, block.attachment), messageId })
        break
      /* v8 ignore next 2 -- validateReplayableHistory rejects merge-extensible content first. */
      default:
        throw new Error(`unsupported restored session content: ${(block as { type: string }).type}`)
    }
  }
  return updates
}

function validateReplayableHistory(events: readonly SessionEvent[]): void {
  for (const event of events) {
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      for (const block of event.data.content) {
        if (block.type !== 'text' && block.type !== 'image') {
          throw new Error(`unsupported restored user message content: ${block.type}`)
        }
      }
    } else if (event.type === 'assistant/message') {
      const supportedTypes: ReadonlySet<string> = new Set(['text', 'reasoning', 'image', 'tool-call', 'tool-result'])
      for (const block of event.data.message.content) {
        /* v8 ignore next 2 -- typed first-party content is exhaustive; durable data still fails closed. */
        if (!supportedTypes.has(block.type)) {
          throw new Error(`unsupported restored session content: ${(block as { type: string }).type}`)
        }
      }
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
  const sample = `${turn}:${step}:${used}`
  if (record.usage.lastSample === sample) return []
  record.usage.lastSample = sample
  record.usage.used = used
  return record.usage.size === undefined
    ? []
    : [{ sessionUpdate: 'usage_update', size: record.usage.size, used }]
}

function assistantMessageId(sessionId: SessionId, turn: number, step: number): string {
  return `${sessionId}:assistant:${turn}:${step}`
}

function thoughtMessageId(messageId: string): string {
  return `${messageId}:thought`
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
}

function validateRestoredSessionParams(params: LoadSessionRequest | ResumeSessionRequest): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported')
  }
}

/** Dispose MCP and agent ownership even when either teardown reports failure. */
async function disposeRecord(record: SessionRecord): Promise<void> {
  const mcp = await Promise.allSettled([record.mcp.dispose()])
  const agent = await Promise.allSettled([record.dispose()])
  const failures = [...mcp, ...agent].flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
  if (failures.length > 0) throw new AggregateError(failures, failures.map(errorChain).join('; '))
}
