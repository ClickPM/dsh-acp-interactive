import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  makeHarness,
  reasoningResponse,
  textResponse,
  type BridgeHarness,
} from './harness.js'

function toolCallResponse() {
  return [
    { type: 'block-start' as const, index: 0, blockType: 'tool-call' as const },
    {
      type: 'block-end' as const,
      index: 0,
      block: { type: 'tool-call' as const, id: 'history-call' as never, name: 'echo', arguments: '{}' },
    },
    { type: 'finish' as const, reason: { kind: 'tool-calls' as const } },
  ]
}

describe('interactive ACP persisted sessions', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('advertises list, load, resume, and close without advertising deletion', async () => {
    harness = await makeHarness([])
    await expect(harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })).resolves.toMatchObject({
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
        },
      },
    })
    const initialized = await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    expect(initialized.agentCapabilities?.sessionCapabilities).not.toHaveProperty('delete')
  })

  it('lists newest sessions with titles, exact cwd filtering, and no cwd-less rows', async () => {
    harness = await makeHarness([textResponse('seed answer')])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const cwd = process.cwd()
    const { sessionId: sourceId } = await harness.client.newSession({ cwd, mcpServers: [] })
    await harness.client.prompt({ sessionId: sourceId, prompt: [{ type: 'text', text: 'seed question' }] })
    const source = harness.ctx.agents.get(SessionId(sourceId))
    if (source === undefined) throw new Error('missing source session')
    source.session.append('session/title', {
      title: 'Persisted source',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    const events = structuredClone(source.session.events)
    await harness.client.closeSession({ sessionId: sourceId })

    const older = SessionId('older-session')
    const newer = SessionId('newer-session')
    const untitled = SessionId('untitled-session')
    const cwdless = SessionId('cwdless-session')
    harness.persisted.set(older, {
      meta: { ...structuredClone(source.session.header), id: older, createdAt: 1 },
      events: structuredClone(events),
    })
    harness.persisted.set(newer, {
      meta: { ...structuredClone(source.session.header), id: newer, createdAt: 2 },
      events: structuredClone(events),
    })
    harness.persisted.set(untitled, {
      meta: { ...structuredClone(source.session.header), id: untitled, createdAt: 0 },
      events: structuredClone(events).slice(0, -1),
    })
    const { cwd: _ignored, ...cwdlessHeader } = structuredClone(source.session.header)
    harness.persisted.set(cwdless, {
      meta: { ...cwdlessHeader, id: cwdless, createdAt: 3 },
      events: structuredClone(events),
    })

    await expect(harness.client.listSessions({})).resolves.toEqual({
      sessions: [
        { sessionId: newer, cwd, title: 'Persisted source' },
        { sessionId: older, cwd, title: 'Persisted source' },
        { sessionId: untitled, cwd },
      ],
    })
    await expect(harness.client.listSessions({ cwd })).resolves.toEqual({
      sessions: [
        { sessionId: newer, cwd, title: 'Persisted source' },
        { sessionId: older, cwd, title: 'Persisted source' },
        { sessionId: untitled, cwd },
      ],
    })
    await expect(harness.client.listSessions({ cwd: null })).resolves.toEqual({
      sessions: [
        { sessionId: newer, cwd, title: 'Persisted source' },
        { sessionId: older, cwd, title: 'Persisted source' },
        { sessionId: untitled, cwd },
      ],
    })
    await expect(harness.client.listSessions({ cwd: `${cwd}-other` })).resolves.toEqual({ sessions: [] })
    await expect(harness.client.listSessions({ cursor: 'next' })).rejects.toThrow(/cursors are not supported/)
    await expect(harness.client.listSessions({ cwd: 'relative' })).rejects.toThrow(/absolute path/)
    const warnings: string[] = []
    harness.ctx.logger.warn = (message: string) => { warnings.push(message) }
    vi.spyOn(harness.ctx.sessionQuery, 'readTitleSnapshots').mockResolvedValueOnce([
      { sessionId: newer, status: 'rejected', reason: new Error('title unavailable') },
      { sessionId: older, status: 'fulfilled', value: { session: harness.persisted.get(older)!.meta } },
      { sessionId: untitled, status: 'fulfilled', value: { session: harness.persisted.get(untitled)!.meta } },
    ])
    await harness.client.listSessions({ cwd })
    expect(warnings.some(message => message.includes('title unavailable'))).toBe(true)
    await expect(harness.client.resumeSession({ sessionId: cwdless, cwd })).rejects.toThrow(/no recorded cwd/)
  })

  it('loads assembled history once and leaves the restored session reusable', async () => {
    harness = await makeHarness([reasoningResponse(), textResponse('new answer')])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const cwd = process.cwd()
    const { sessionId } = await harness.client.newSession({ cwd, mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'historic question' }] })
    const source = harness.ctx.agents.get(SessionId(sessionId))
    if (source === undefined) throw new Error('missing source session')
    source.session.append('todo/write', { todos: [{ content: 'resume work', status: 'in_progress' }] })
    source.session.append('session/title', {
      title: 'Restored conversation',
      messageSeqs: [],
      source: { kind: 'user' },
    })
    harness.persisted.set(SessionId(sessionId), {
      meta: structuredClone(source.session.header),
      events: structuredClone(source.session.events),
    })
    const persistedHeader = harness.persisted.get(SessionId(sessionId))?.events
      .find(event => event.type === 'request/header')
    if (persistedHeader?.type !== 'request/header') throw new Error('missing persisted request header')
    Object.assign(persistedHeader.data.header.config, { reasoningEffort: 'high' })
    await harness.client.closeSession({ sessionId })
    harness.updates.length = 0

    const loaded = await harness.client.loadSession({
      sessionId,
      cwd,
      mcpServers: [],
    })
    expect(Array.isArray(loaded.configOptions)).toBe(true)
    const history = harness.updates
      .filter(update => update.sessionId === sessionId)
      .flatMap(({ update }) => update.sessionUpdate === 'user_message_chunk'
        || update.sessionUpdate === 'agent_message_chunk'
        ? [update.content.type === 'text' ? `${update.sessionUpdate}:${update.content.text}` : 'rich']
        : [])
    expect(history).toEqual([
      'user_message_chunk:historic question',
      'agent_message_chunk:done',
    ])
    expect(harness.updates.map(update => update.update)).toContainEqual(expect.objectContaining({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'inspect first' },
    }))
    expect(harness.updates.map(update => update.update)).toContainEqual({
      sessionUpdate: 'plan',
      entries: [{ content: 'resume work', priority: 'medium', status: 'in_progress' }],
    })
    expect(harness.updates.map(update => update.update)).toContainEqual(expect.objectContaining({
      sessionUpdate: 'session_info_update',
      title: 'Restored conversation',
    }))
    expect(harness.updates.map(update => update.update)).toContainEqual({
      sessionUpdate: 'usage_update',
      size: 128_000,
      used: 42,
    })
    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'continue' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('resumes without replaying history and rejects mismatched setup parameters', async () => {
    harness = await makeHarness([textResponse('stored')])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const cwd = process.cwd()
    const { sessionId } = await harness.client.newSession({ cwd, mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'question' }] })
    const source = harness.ctx.agents.get(SessionId(sessionId))
    if (source === undefined) throw new Error('missing source session')
    harness.persisted.set(SessionId(sessionId), {
      meta: structuredClone(source.session.header),
      events: structuredClone(source.session.events),
    })
    await harness.client.closeSession({ sessionId })
    harness.updates.length = 0

    const resumed = await harness.client.resumeSession({ sessionId, cwd })
    expect(Array.isArray(resumed.configOptions)).toBe(true)
    expect(harness.updates.map(update => update.update.sessionUpdate)).toEqual(['available_commands_update'])
    await expect(harness.client.resumeSession({ sessionId, cwd })).rejects.toThrow(/already active/)
    await harness.client.closeSession({ sessionId })
    await expect(harness.client.resumeSession({ sessionId, cwd: `${cwd}-wrong` })).rejects.toThrow(/does not match/)
    await expect(harness.client.resumeSession({ sessionId, cwd: 'relative' })).rejects.toThrow(/absolute path/)
    await expect(harness.client.resumeSession({
      sessionId,
      cwd,
      additionalDirectories: [cwd],
    })).rejects.toThrow(/additionalDirectories/)
    await expect(harness.client.resumeSession({
      sessionId,
      cwd,
      mcpServers: [{ type: 'acp', name: 'test', serverId: 'test' }],
    })).rejects.toThrow(/ACP transport is not supported/)
  })

  it('closes an in-flight turn, settles it as cancelled, and releases the agent', async () => {
    harness = await makeHarness(['hang'])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'wait' }] })
    await vi.waitFor(() => {
      expect(harness!.updates.some(update => update.update.sessionUpdate === 'agent_message_chunk')).toBe(true)
    })

    await expect(harness.client.closeSession({ sessionId })).resolves.toEqual({})
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
    await expect(harness.client.closeSession({ sessionId })).rejects.toThrow(/unknown session/)
  })

  it('shares concurrent close work and rejects prompts after closing starts', async () => {
    harness = await makeHarness([])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const draining = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    harness.ctx.provide('subagents', {
      drainContinuableDescendants: () => {
        draining.resolve(undefined)
        return release.promise
      },
    } as never)

    const first = harness.client.closeSession({ sessionId })
    await draining.promise
    const second = harness.client.closeSession({ sessionId })
    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'too late' }],
    })).rejects.toThrow(/session is closing/)
    const disposing = harness.acpFiber.dispose()
    release.resolve(undefined)
    await expect(Promise.all([first, second, disposing])).resolves.toEqual([{}, {}, undefined])
  })

  it('distinguishes an agent owned outside this ACP connection', async () => {
    harness = await makeHarness([])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const id = SessionId('outside-agent')
    const cwd = process.cwd()
    const handle = await harness.ctx.agents.create({ sessionId: id, meta: { cwd } })
    try {
      await expect(harness.client.resumeSession({ sessionId: id, cwd }))
        .rejects.toThrow(/active outside this ACP connection/)
    } finally {
      await handle.dispose()
    }
  })

  it('cancels a restore that session/close reaches before publication', async () => {
    harness = await makeHarness([])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const id = SessionId('slow-restore')
    const cwd = process.cwd()
    harness.persisted.set(id, {
      meta: { version: 0, id, createdAt: 1, cwd },
      events: [],
    })
    const read = harness.ctx.sessionQuery.readSession.bind(harness.ctx.sessionQuery)
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(harness.ctx.sessionQuery, 'readSession').mockImplementation(async (sessionId) => {
      started.resolve(undefined)
      await release.promise
      return read(sessionId)
    })

    const resuming = harness.client.resumeSession({ sessionId: id, cwd })
    await started.promise
    const closing = harness.client.closeSession({ sessionId: id })
    release.resolve(undefined)
    await expect(resuming).rejects.toThrow(/restore failed/)
    await expect(closing).resolves.toEqual({})
    expect(harness.ctx.agents.get(id)).toBeUndefined()
  })

  it('disposes an unpublished restored handle when the ACP connection closes', async () => {
    harness = await makeHarness([])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const id = SessionId('disconnected-restore')
    const cwd = process.cwd()
    harness.persisted.set(id, {
      meta: { version: 0, id, createdAt: 1, cwd },
      events: [],
    })
    const resume = harness.ctx.agents.resume.bind(harness.ctx.agents)
    const handleReady = Promise.withResolvers<undefined>()
    const aborted = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(harness.ctx.agents, 'resume').mockImplementation(async (options) => {
      const handle = await resume(options)
      options.signal?.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      handleReady.resolve(undefined)
      await release.promise
      return handle
    })

    const resuming = harness.client.resumeSession({ sessionId: id, cwd })
    await handleReady.promise
    await harness.closeClientTransport()
    await aborted.promise
    release.resolve(undefined)
    await expect(resuming).rejects.toThrow(/ACP connection closed/)
    await vi.waitFor(() => { expect(harness!.ctx.agents.get(id)).toBeUndefined() })
  })

  it('replays tool cards and refuses richer persisted content before publishing an agent', async () => {
    harness = await makeHarness([toolCallResponse(), textResponse('after tool')])
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'Echo',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'tool output' }]),
    }))
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const cwd = process.cwd()
    const { sessionId } = await harness.client.newSession({ cwd, mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'use a tool' }] })
    const source = harness.ctx.agents.get(SessionId(sessionId))
    if (source === undefined) throw new Error('missing source session')
    const events = structuredClone(source.session.events)
    harness.persisted.set(SessionId(sessionId), { meta: structuredClone(source.session.header), events })
    await harness.client.closeSession({ sessionId })
    harness.updates.length = 0

    await harness.client.loadSession({ sessionId, cwd, mcpServers: [] })
    expect(harness.updates.map(update => update.update.sessionUpdate)).toEqual(expect.arrayContaining([
      'tool_call',
      'tool_call_update',
    ]))
    await harness.client.closeSession({ sessionId })

    const user = events.find(event => event.type === 'user/message')
    if (user?.type !== 'user/message') throw new Error('missing user event')
    Object.assign(user.data, { source: { kind: 'plugin', plugin: 'test' } })
    harness.updates.length = 0
    await harness.client.loadSession({ sessionId, cwd, mcpServers: [] })
    expect(harness.updates.some(update => update.update.sessionUpdate === 'user_message_chunk')).toBe(false)
    await harness.client.closeSession({ sessionId })
    Object.assign(user.data, { source: { kind: 'user' } })

    Object.assign(user.data, { content: [{ type: 'reasoning', text: 'private' }] })
    await expect(harness.client.loadSession({ sessionId, cwd, mcpServers: [] }))
      .rejects.toThrow(/unsupported restored user message content: reasoning/)
    Object.assign(user.data, { content: [{
      type: 'tool-call',
      id: 'user-tool',
      name: 'echo',
      arguments: '{}',
    }] })
    await expect(harness.client.loadSession({ sessionId, cwd, mcpServers: [] }))
      .rejects.toThrow(/unsupported restored user message content: tool-call/)
    Object.assign(user.data, { content: [{ type: 'chart', data: 'x' }] })
    await expect(harness.client.loadSession({ sessionId, cwd, mcpServers: [] }))
      .rejects.toThrow(/unsupported restored user message content: chart/)
    Object.assign(user.data, { content: [{ type: 'text', text: 'restored' }] })
    const result = events.find(event => event.type === 'tool/result')
    if (result?.type !== 'tool/result') throw new Error('missing tool result')
    Object.assign(result.data.message.content[0], { content: [{
      type: 'image',
      attachment: { attachmentId: 'result-image', mediaType: 'image/png', bytes: 1 },
    }] })
    await expect(harness.client.loadSession({ sessionId, cwd, mcpServers: [] }))
      .rejects.toThrow(/unsupported restored tool result content/)
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  })
})
