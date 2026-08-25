import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
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
