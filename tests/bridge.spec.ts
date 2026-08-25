import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import { MODEL_CONFIG_ID, PERMISSION_CONFIG_ID } from '../src/config-options.js'
import { makeHarness, reasoningResponse, type BridgeHarness } from './harness.js'

describe('interactive ACP bridge', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('streams thought, message, usage, title, plan, and command snapshots to the exact session', async () => {
    harness = await makeHarness([reasoningResponse()])
    harness.ctx.commands.register({
      name: 'inspect',
      description: 'Inspect the workspace',
      input: { hint: '<path>' },
      handler: () => ({ kind: 'success' }),
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'work' }] })

    const agent = harness.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error('missing bridge-owned agent')
    agent.session.append('todo/write', { todos: [{ content: 'ship phase one', status: 'in_progress' }] })
    agent.session.append('session/title', {
      title: 'Interactive ACP',
      messageSeqs: [],
      source: { kind: 'user' },
    })

    await vi.waitFor(() => {
      expect(harness!.updates.some(item => item.update.sessionUpdate === 'session_info_update')).toBe(true)
    })
    const own = harness.updates.filter(update => update.sessionId === sessionId).map(item => item.update)
    expect(own).toContainEqual({
      sessionUpdate: 'available_commands_update',
      availableCommands: [{
        name: 'inspect',
        description: 'Inspect the workspace',
        input: { hint: '<path>' },
      }],
    })
    expect(own).toContainEqual({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'inspect first' },
    })
    expect(own).toContainEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'done' },
    })
    expect(own).toContainEqual({ sessionUpdate: 'usage_update', size: 128_000, used: 46 })
    expect(own).toContainEqual({
      sessionUpdate: 'plan',
      entries: [{ content: 'ship phase one', priority: 'medium', status: 'in_progress' }],
    })
    expect(own).toContainEqual(expect.objectContaining({
      sessionUpdate: 'session_info_update',
      title: 'Interactive ACP',
    }))
  })

  it('executes slash commands without making a model request', async () => {
    harness = await makeHarness([])
    harness.ctx.commands.register({
      name: 'hello',
      description: 'Say hello',
      handler: () => ({ kind: 'success', text: 'hello from dsh' }),
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/hello' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    expect(harness.adapter.requests).toHaveLength(0)
    expect(harness.updates).toContainEqual({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello from dsh' },
      },
    })
  })

  it('routes bridge-owned approvals through ACP one-shot choices', async () => {
    harness = await makeHarness([])
    await harness.ctx.plugin(ApprovalService)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const agent = harness.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error('missing bridge-owned agent')
    agent.session.append('turn/start', { turn: 1 })

    await expect(harness.ctx.approval.request({
      agent,
      toolName: 'bash',
      callId: CallId('call-1'),
    })).resolves.toBe('allowed-once')
    expect(harness.permissionRequests).toEqual([{
      sessionId,
      toolCall: { toolCallId: 'call-1' },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    }])
  })

  it('selects an exact model for the next request and rejects unknown configuration values', async () => {
    harness = await makeHarness([reasoningResponse()])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(created.configOptions).toContainEqual(expect.objectContaining({
      id: MODEL_CONFIG_ID,
      currentValue: 'mock:mock',
      category: 'model',
    }))

    const selected = await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: MODEL_CONFIG_ID,
      value: 'mock:alternate',
    })
    expect(selected.configOptions).toContainEqual(expect.objectContaining({
      id: MODEL_CONFIG_ID,
      currentValue: 'mock:alternate',
    }))
    await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'use the selected route' }],
    })
    expect(harness.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'alternate' })

    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: 'missing',
      value: 'x',
    })).rejects.toThrow(/unknown session configuration option/)
    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: MODEL_CONFIG_ID,
      value: 'malformed',
    })).rejects.toThrow(/unknown model selection/)
    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: MODEL_CONFIG_ID,
      value: 'mock:unlisted',
    })).rejects.toThrow(/unknown model selection/)

    vi.spyOn(harness.ctx.llm, 'resolveCallConfig').mockRejectedValueOnce(new Error('route offline'))
    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: MODEL_CONFIG_ID,
      value: 'mock:mock',
    })).rejects.toThrow(/model is unavailable.*route offline/)
  })

  it('routes permission configuration through the session command and refuses a running switch', async () => {
    harness = await makeHarness(['hang'])
    harness.ctx.provide('shell', {
      sandboxMode: 'workspace-write',
      resolve() { throw new Error('permission selector test does not execute shell') },
      run() { throw new Error('permission selector test does not execute shell') },
      start() { throw new Error('permission selector test does not execute shell') },
    })
    await harness.ctx.plugin(ApprovalService)
    await harness.ctx.plugin(PermissionPresetService, {})
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(created.configOptions).toContainEqual(expect.objectContaining({
      id: PERMISSION_CONFIG_ID,
      currentValue: 'workspace-write',
    }))
    const switched = await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: PERMISSION_CONFIG_ID,
      value: 'danger-full-access',
    })
    expect(switched.configOptions).toContainEqual(expect.objectContaining({
      id: PERMISSION_CONFIG_ID,
      currentValue: 'danger-full-access',
    }))

    const prompt = harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'keep running' }],
    })
    await vi.waitFor(() => { expect(harness!.adapter.requests).toHaveLength(1) })
    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: PERMISSION_CONFIG_ID,
      value: 'workspace-write',
    })).rejects.toThrow(/cannot change while the session is running/)
    await harness.client.cancel({ sessionId: created.sessionId })
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('fails closed for unavailable permission controls and blocks prompts behind model changes', async () => {
    harness = await makeHarness([])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: PERMISSION_CONFIG_ID,
      value: 'workspace-write',
    })).rejects.toThrow(/permission configuration is unavailable/)
    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: MODEL_CONFIG_ID,
      type: 'boolean',
      value: true,
    })).rejects.toThrow(/model configuration requires a select value/)

    const deferred = Promise.withResolvers<Awaited<ReturnType<typeof harness.ctx.llm.resolveCallConfig>>>()
    vi.spyOn(harness.ctx.llm, 'resolveCallConfig').mockReturnValueOnce(deferred.promise)
    const selecting = harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: MODEL_CONFIG_ID,
      value: 'mock:alternate',
    })
    await vi.waitFor(() => { expect(harness!.ctx.llm.resolveCallConfig).toHaveBeenCalled() })
    await expect(harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'too soon' }],
    })).rejects.toThrow(/configuration change is in flight/)
    deferred.resolve({ provider: 'mock', model: 'alternate' })
    await expect(selecting).resolves.toHaveProperty('configOptions')
  })

  it('contains configuration refresh failures and refuses missing permission commands', async () => {
    harness = await makeHarness([])
    const warnings: string[] = []
    harness.ctx.logger.warn = (message: string) => { warnings.push(message) }
    harness.ctx.provide('permissionPresets', {
      names: ['safe'],
      current: () => 'safe',
      optionOf: (value: string) => ({ value, name: value }),
    })
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: PERMISSION_CONFIG_ID,
      value: 'unknown',
    })).rejects.toThrow(/unknown permission preset/)
    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: PERMISSION_CONFIG_ID,
      value: 'safe',
    })).rejects.toThrow(/permission command is unavailable/)

    vi.spyOn(harness.ctx.llm, 'listProviders').mockImplementationOnce(() => { throw new Error('directory failed') })
    harness.ctx.emit('llm/adapters-updated')
    await vi.waitFor(() => {
      expect(warnings.some(message => message.includes('config option refresh failed'))).toBe(true)
    })
  })

  it('cancels an in-flight model turn and keeps the session reusable', async () => {
    harness = await makeHarness(['hang', reasoningResponse()])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const pending = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'wait' }] })
    await vi.waitFor(() => {
      expect(harness!.updates.some(item => item.update.sessionUpdate === 'agent_message_chunk')).toBe(true)
    })
    await harness.client.cancel({ sessionId })
    await expect(pending).resolves.toEqual({ stopReason: 'cancelled' })
    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'again' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('rejects rich prompt blocks instead of silently dropping them', async () => {
    harness = await makeHarness([])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'resource_link', name: 'file', uri: 'file:///tmp/a' }],
    })).rejects.toThrow(/unsupported prompt content/)
  })
})
