import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import ApprovalService, { type ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import {
  deferred,
  errorResponse,
  makeHarness,
  maxTokensResponse,
  textResponse,
  type BridgeHarness,
} from './harness.js'

async function initialize(harness: BridgeHarness, terminal = false): Promise<void> {
  await harness.client.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: terminal ? { _meta: { terminal_output: true } } : {},
  })
}

async function newSession(harness: BridgeHarness): Promise<string> {
  await initialize(harness)
  return (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
}

function ownedAgent(harness: BridgeHarness, sessionId: string): Agent {
  const agent = harness.ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) throw new Error('missing bridge-owned agent')
  return agent
}

function emitOwned(harness: BridgeHarness, agent: Agent, event: SessionEvent): void {
  harness.ctx.emit('session/event', agent.session, event)
}

function toolCallResponse(): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: CallId('call-1'), name: 'echo', argumentsDelta: '{"text":"hi"}' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: CallId('call-1'), name: 'echo', arguments: '{"text":"hi"}' },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe('interactive ACP bridge edges', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose().catch(() => undefined)
    harness = undefined
  })

  it('negotiates capabilities, no-op authentication, and omitted agent targets', async () => {
    harness = await makeHarness([])
    const response = await harness.client.initialize({ protocolVersion: 0, clientCapabilities: {} })
    expect(response).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'deepseek-harness-interactive-acp', version: '0.2.0' },
      agentCapabilities: { promptCapabilities: { image: false, audio: false, embeddedContext: false } },
    })
    await expect(harness.client.authenticate({ methodId: 'unused' })).resolves.toEqual({})

    const blank = await makeHarness([], {})
    try {
      await blank.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
      const { sessionId } = await blank.client.newSession({ cwd: process.cwd(), mcpServers: [] })
      expect(blank.ctx.agents.get(SessionId(sessionId))?.options).toEqual({})
    } finally {
      await blank.dispose()
    }
  })

  it('validates session parameters and unknown session operations', async () => {
    harness = await makeHarness([])
    await initialize(harness)
    await expect(harness.client.newSession({ cwd: 'relative', mcpServers: [] })).rejects.toThrow(/absolute path/)
    await expect(harness.client.newSession({
      cwd: process.cwd(), mcpServers: [], additionalDirectories: [process.cwd()],
    })).rejects.toThrow(/additionalDirectories/)
    await expect(harness.client.newSession({
      cwd: process.cwd(), mcpServers: [{ name: 'x', command: 'node', args: [], env: [] }],
    })).rejects.toThrow(/mcpServers/)
    await expect(harness.client.newSession({ cwd: process.cwd(), mcpServers: [], additionalDirectories: [] }))
      .resolves.toHaveProperty('sessionId')
    await expect(harness.client.prompt({ sessionId: 'missing', prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/unknown session/)
    await expect(harness.client.cancel({ sessionId: 'missing' })).resolves.toBeUndefined()
  })

  it('enforces one in-flight prompt and maps max-token, blocked, and error endings', async () => {
    harness = await makeHarness(['hang', maxTokensResponse('cut'), errorResponse('provider failed')])
    const sessionId = await newSession(harness)
    const pending = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'wait' }] })
    await vi.waitFor(() => { expect(ownedAgent(harness!, sessionId).status).toBe('running') })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'again' }] }))
      .rejects.toThrow(/already in flight/)
    await harness.client.cancel({ sessionId })
    await expect(pending).resolves.toEqual({ stopReason: 'cancelled' })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'limit' }] }))
      .resolves.toEqual({ stopReason: 'max_tokens' })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'fail' }] }))
      .rejects.toThrow(/provider failed/)

    const blocked = await makeHarness([])
    try {
      blocked.ctx.on('agent/pre-step', async () => ({ kind: 'reject' as const }))
      const blockedId = await newSession(blocked)
      await expect(blocked.client.prompt({ sessionId: blockedId, prompt: [{ type: 'text', text: 'blocked' }] }))
        .resolves.toEqual({ stopReason: 'end_turn' })
    } finally {
      await blocked.dispose()
    }
  })

  it('reports a disposed destination and contains a synchronous followup failure', async () => {
    harness = await makeHarness([])
    const sessionId = await newSession(harness)
    await harness.loopFiber.dispose()
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }))
      .rejects.toThrow(/disposed outside the bridge/)

    const throwing = await makeHarness([])
    try {
      const throwingId = await newSession(throwing)
      const agent = ownedAgent(throwing, throwingId)
      const unrenderable = { toString: () => { throw new Error('no string') } }
      vi.spyOn(agent, 'followup').mockImplementationOnce(() => { throw unrenderable })
      await expect(throwing.client.prompt({ sessionId: throwingId, prompt: [{ type: 'text', text: 'go' }] }))
        .rejects.toThrow(/<unrenderable thrown value>/)
    } finally {
      await throwing.dispose()
    }
  })

  it('settles a prompt removed before claim and reports an interval agent failure', async () => {
    harness = await makeHarness([])
    const sessionId = await newSession(harness)
    const remove = harness.ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (message.source.kind === 'user') agent.inbox.remove(message.id)
    })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'remove' }] }))
      .resolves.toEqual({ stopReason: 'cancelled' })
    remove()

    const failed = await makeHarness(['hang'])
    try {
      const failedId = await newSession(failed)
      const agent = ownedAgent(failed, failedId)
      const prompt = failed.client.prompt({ sessionId: failedId, prompt: [{ type: 'text', text: 'run' }] })
      await vi.waitFor(() => { expect(agent.status).toBe('running') })
      failed.ctx.emit('agent/error', { agent, turn: 999, step: 1, error: new Error('interval failed') })
      agent.cancel({ kind: 'hook', reason: 'settle synthetic failure' })
      await expect(prompt).rejects.toThrow(/interval failed/)
    } finally {
      await failed.dispose()
    }
  })

  it('renders unknown, error, empty, throwing, and cancelled commands', async () => {
    harness = await makeHarness([])
    harness.ctx.commands.register({ name: 'error', description: 'Error', handler: () => ({ kind: 'error', text: 'bad input' }) })
    harness.ctx.commands.register({ name: 'empty', description: 'Empty', handler: () => ({ kind: 'success' }) })
    harness.ctx.commands.register({ name: 'throw', description: 'Throw', handler: () => { throw new Error('command exploded') } })
    const started = deferred<undefined>()
    harness.ctx.commands.register({
      name: 'wait',
      description: 'Wait',
      handler: ({ signal }) => {
        started.resolve(undefined)
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
        })
      },
    })
    const sessionId = await newSession(harness)
    harness.ctx.commands.register({ name: 'late', description: 'Late', handler: () => ({ kind: 'success' }) })
    await vi.waitFor(() => {
      expect(harness!.updates.some(item => item.update.sessionUpdate === 'available_commands_update'
        && item.update.availableCommands.some(command => command.name === 'late'))).toBe(true)
    })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/missing' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/error' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/empty' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/throw' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    const waiting = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/wait' }] })
    await started.promise
    await harness.client.cancel({ sessionId })
    await expect(waiting).resolves.toEqual({ stopReason: 'cancelled' })
    const output = harness.updates.flatMap(item => item.update.sessionUpdate === 'agent_message_chunk'
      && item.update.content.type === 'text' ? [item.update.content.text] : [])
    expect(output).toContain('Error: unknown command: /missing')
    expect(output).toContain('Error: bad input')
    expect(output).toContain('Error: command failed: Error: command exploded')
  })

  it('maps approval cancellation and rejection while delegating foreign requests', async () => {
    harness = await makeHarness([])
    await harness.ctx.plugin(ApprovalService)
    const sessionId = await newSession(harness)
    const agent = ownedAgent(harness, sessionId)
    agent.session.append('turn/start', { turn: 1 })
    const request: ApprovalRequest = { agent, toolName: 'bash', callId: CallId('call-1') }
    harness.onPermission = () => ({ outcome: { outcome: 'cancelled' } })
    await expect(harness.ctx.approval.request(request)).resolves.toBe('cancelled')
    harness.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'unknown' } })
    await expect(harness.ctx.approval.request(request)).resolves.toBe('rejected')

    const foreign = { session: agent.session } as unknown as Agent
    const before = harness.permissionRequests.length
    await expect(harness.ctx.waterfall('approval/request', {
      agent: foreign, toolName: 'bash', callId: CallId('foreign'),
    }, () => Promise.resolve('unavailable' as const))).resolves.toBe('unavailable')
    await expect(harness.ctx.waterfall('approval/request', {
      agent, toolName: 'bash',
    }, () => Promise.resolve('unavailable' as const))).resolves.toBe('unavailable')
    expect(harness.permissionRequests).toHaveLength(before)
  })

  it('projects real generic tool calls and results with persisted metadata', async () => {
    harness = await makeHarness([toolCallResponse(), textResponse('done')])
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'Echo text',
      parameters: { text: { type: 'string' } },
      presentCall: args => ({ card: 'generic', title: `Echo ${args.text}`, kind: 'other' }),
      presentResult: (_args, result) => ({ card: 'generic', title: 'Echoed', content: result.content }),
      execute: () => Promise.resolve([{ type: 'text', text: 'tool output' }]),
    }))
    const sessionId = await newSession(harness)
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'use echo' }] })
    const own = harness.updates.filter(item => item.sessionId === sessionId).map(item => item.update)
    expect(own).toContainEqual(expect.objectContaining({
      sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Echo hi', status: 'in_progress',
    }))
    expect(own).toContainEqual(expect.objectContaining({
      sessionUpdate: 'tool_call_update', toolCallId: 'call-1', title: 'Echoed', status: 'completed',
    }))
  })

  it('contains malformed event projection and faulty tool presentation', async () => {
    harness = await makeHarness([])
    const warnings: string[] = []
    harness.ctx.logger.warn = (message: string) => { warnings.push(message) }
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'broken-card',
      description: 'Broken presenter',
      parameters: {},
      presentCall: () => { throw new Error('presenter failed') },
      execute: () => Promise.resolve([]),
    }))
    const sessionId = await newSession(harness)
    const agent = ownedAgent(harness, sessionId)
    emitOwned(harness, agent, {
      type: 'tool/call', seq: 1, time: 1,
      data: { turn: 1, step: 1, callId: CallId('broken'), name: 'broken-card', arguments: '{}' },
    })
    emitOwned(harness, agent, {
      type: 'tool/result', seq: 2, time: 2, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { content: [] } as never },
    })
    await vi.waitFor(() => {
      expect(warnings.some(message => message.includes('presenter failed'))).toBe(true)
      expect(warnings.some(message => message.includes('event projection failed'))).toBe(true)
    })
  })

  it('projects direct event variants, deduplicates usage, and ignores foreign/replacement events', async () => {
    harness = await makeHarness([])
    const sessionId = await newSession(harness)
    const agent = ownedAgent(harness, sessionId)
    const foreign = Session.create(SessionId('foreign'))
    emitOwned(harness, agent, {
      type: 'assistant/chunk', seq: 1, time: 1,
      data: { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    })
    emitOwned(harness, agent, {
      type: 'assistant/message', seq: 2, time: 2, surfaceOp: 'append',
      data: {
        turn: 1,
        step: 1,
        message: createAssistantMessage({ content: [], source: { provider: 'mock', model: 'mock' } }),
      },
    })
    const usageEvent: SessionEvent = {
      type: 'assistant/chunk', seq: 3, time: 3,
      data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 2, outputTokens: 3 } } },
    }
    emitOwned(harness, agent, usageEvent)
    emitOwned(harness, agent, {
      type: 'request/context', seq: 4, time: 4,
      data: { provider: 'mock', model: 'mock' },
    })
    emitOwned(harness, agent, {
      type: 'request/context', seq: 5, time: 5,
      data: { provider: 'mock', model: 'mock', contextWindow: 100 },
    })
    emitOwned(harness, agent, usageEvent)
    emitOwned(harness, agent, {
      type: 'assistant/message', seq: 6, time: 6, surfaceOp: 'append',
      data: {
        turn: 1,
        step: 2,
        message: createAssistantMessage({ content: [], source: { provider: 'mock', model: 'mock' } }),
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 },
      },
    })
    emitOwned(harness, agent, {
      type: 'tool/result', seq: 7, time: 7, surfaceOp: { op: 'replace', start: 1, end: 1 },
      data: {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: CallId('ignored'), content: [{ type: 'text', text: 'x' }], isError: false }),
      },
    })
    harness.ctx.emit('session/event', foreign, {
      type: 'todo/write', seq: 0, time: 0, data: { todos: [{ content: 'foreign', status: 'pending' }] },
    })
    await vi.waitFor(() => {
      expect(harness!.updates.some(item => item.update.sessionUpdate === 'usage_update')).toBe(true)
    })
    const usage = harness.updates.filter(item => item.update.sessionUpdate === 'usage_update')
    expect(usage.map(item => item.update)).toEqual([
      { sessionUpdate: 'usage_update', size: 100, used: 5 },
      { sessionUpdate: 'usage_update', size: 100, used: 4 },
    ])
    expect(harness.updates.some(item => item.update.sessionUpdate === 'plan'
      && item.update.entries.some(entry => entry.content === 'foreign'))).toBe(false)
    expect(harness.updates.some(item => item.update.sessionUpdate === 'tool_call_update'
      && item.update.toolCallId === 'ignored')).toBe(false)
  })

  it('ignores mismatched agent lifecycle events and cancels autonomous work', async () => {
    harness = await makeHarness(['hang'])
    const sessionId = await newSession(harness)
    const agent = ownedAgent(harness, sessionId)
    const foreign = { session: agent.session } as unknown as Agent
    harness.ctx.emit('agent/error', { agent: foreign, turn: 1, step: 1, error: new Error('foreign') })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'autonomous' }],
      source: { kind: 'plugin', plugin: 'test' },
    }))
    await vi.waitFor(() => { expect(agent.status).toBe('running') })
    await harness.client.cancel({ sessionId })
    await agent.whenIdle()
    expect(agent.status).toBe('idle')
  })
})
