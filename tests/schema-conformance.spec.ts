import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  methods,
  PROTOCOL_VERSION,
  RequestError,
} from '@agentclientprotocol/sdk'
import schema from '@agentclientprotocol/sdk/schema/schema.json' with { type: 'json' }
import { SessionId } from '@deepseek-ai/dsh-session'
import { makeHarness, textResponse, type BridgeHarness } from './harness.js'

describe('stable ACP v1 schema conformance', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
  })

  it('pins the SDK schema features used by the stage A bridge', () => {
    const definitions = schema.$defs as Record<string, {
      properties?: Record<string, unknown>
      anyOf?: Array<{ const?: string }>
    }>
    expect(definitions.SessionConfigOptionCategory?.anyOf?.map(entry => entry.const)).toContain('model_config')
    expect(definitions.ContentChunk?.properties).toHaveProperty('messageId')
    expect(definitions.UsageUpdate?.properties).toMatchObject({
      used: expect.any(Object),
      size: expect.any(Object),
      cost: expect.any(Object),
    })
    expect(definitions.SetSessionConfigOptionRequest?.anyOf).toHaveLength(2)
    expect(definitions.CreateElicitationResponse?.anyOf).toHaveLength(4)
    expect(definitions.CancelRequestNotification?.properties).toHaveProperty('requestId')
  })

  it('negotiates boolean configuration without advertising a nonexistent domain option', async () => {
    harness = await makeHarness([])
    const initialized = await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { session: { configOptions: { boolean: {} } } },
    })
    expect(initialized.agentCapabilities).not.toHaveProperty('sessionCapabilities.delete')
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(created.configOptions?.every(option => option.type === 'select')).toBe(true)
    await expect(harness.client.request(methods.agent.session.setConfigOption, {
      sessionId: created.sessionId,
      configId: 'unadvertised-boolean',
      type: 'boolean',
      value: true,
    })).rejects.toMatchObject({ code: -32602 })
    await expect(harness.client.request(methods.agent.session.setConfigOption, {
      sessionId: created.sessionId,
      configId: 'malformed-boolean',
      type: 'boolean',
      value: 'yes',
    } as never)).rejects.toMatchObject({ code: -32602 })
    await expect(harness.client.request(methods.agent.session.setConfigOption, {
      sessionId: created.sessionId,
      configId: 'model',
      type: 'boolean',
      value: true,
    })).rejects.toMatchObject({ code: -32602 })
  })

  it('cancels exactly one prompt request through $/cancel_request and keeps both sessions reusable', async () => {
    harness = await makeHarness(['hang', textResponse('other session'), textResponse('first session reused')])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const first = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const second = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const controller = new AbortController()
    const prompting = harness.client.request(methods.agent.session.prompt, {
      sessionId: first.sessionId,
      prompt: [{ type: 'text', text: 'wait' }],
    }, { cancellationSignal: controller.signal })
    await vi.waitFor(() => {
      expect(harness!.updates.some(item => item.sessionId === first.sessionId
        && item.update.sessionUpdate === 'agent_message_chunk')).toBe(true)
    })
    controller.abort(RequestError.requestCancelled({ test: true }))
    await expect(prompting).resolves.toEqual({ stopReason: 'cancelled' })
    await expect(harness.client.prompt({
      sessionId: second.sessionId,
      prompt: [{ type: 'text', text: 'continue elsewhere' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    await expect(harness.client.prompt({
      sessionId: first.sessionId,
      prompt: [{ type: 'text', text: 'continue here' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('propagates request cancellation into a direct command signal', async () => {
    harness = await makeHarness([])
    const started = Promise.withResolvers<void>()
    harness.ctx.commands.register({
      name: 'wait',
      description: 'Wait for cancellation',
      handler: ({ signal }) => new Promise((_resolve, reject) => {
        started.resolve()
        const aborted = (): void => { reject(signal.reason) }
        if (signal.aborted) aborted()
        else signal.addEventListener('abort', aborted, { once: true })
      }),
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const session = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const controller = new AbortController()
    const prompting = harness.client.request(methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: '/wait' }],
    }, { cancellationSignal: controller.signal })
    await started.promise
    controller.abort()
    await expect(prompting).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('keeps message IDs stable between live projection and history replay', async () => {
    harness = await makeHarness([textResponse('stable message')])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'remember me' }],
    })
    const live = harness.updates.find(item => item.sessionId === created.sessionId
      && item.update.sessionUpdate === 'agent_message_chunk'
      && item.update.content.type === 'text'
      && item.update.content.text === 'stable message')
    expect(live?.update).toEqual(expect.objectContaining({ messageId: expect.any(String) }))
    const source = harness.ctx.agents.get(SessionId(created.sessionId))
    if (source === undefined) throw new Error('missing source session')
    harness.persisted.set(SessionId(created.sessionId), {
      meta: structuredClone(source.session.header),
      events: structuredClone(source.session.events),
    })
    await harness.client.closeSession({ sessionId: created.sessionId })
    harness.updates.length = 0
    await harness.client.loadSession({
      sessionId: created.sessionId,
      cwd: process.cwd(),
      mcpServers: [],
    })
    const replayed = harness.updates.find(item => item.sessionId === created.sessionId
      && item.update.sessionUpdate === 'agent_message_chunk'
      && item.update.content.type === 'text'
      && item.update.content.text === 'stable message')
    if (live?.update.sessionUpdate !== 'agent_message_chunk'
      || replayed?.update.sessionUpdate !== 'agent_message_chunk') {
      throw new Error('missing projected assistant message')
    }
    expect(replayed.update.messageId).toBe(live.update.messageId)
  })
})
