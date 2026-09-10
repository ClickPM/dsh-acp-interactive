import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import AttachmentStore, { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import PermissionPresetService from '@deepseek-ai/dsh-permission-presets'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import {
  encodeReasoningValue,
  MODEL_CONFIG_ID,
  PERMISSION_CONFIG_ID,
  REASONING_CONFIG_ID,
} from '../src/config-options.js'
import { makeHarness, reasoningResponse, type BridgeHarness } from './harness.js'

class HarnessAttachments extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 1024,
    maxImagesPerMessage: 2,
    maxMessageImageBytes: 2048,
    maxImagePixels: 100,
    maxImageDimension: 10,
    mediaTypes: ['image/png'],
  }
  private readonly stored = new Map<string, StoredImageAttachment>()

  validateImage(): Promise<void> {
    return Promise.resolve()
  }

  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId(`image-${this.stored.size}`),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }
    this.stored.set(ref.attachmentId, { ref, data: input.data })
    return Promise.resolve(ref)
  }

  readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    const stored = this.stored.get(ref.attachmentId)
    return stored === undefined ? Promise.reject(new Error('missing image')) : Promise.resolve(stored)
  }
}

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
    expect(own).toContainEqual(expect.objectContaining({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'inspect first' },
    }))
    expect(own).toContainEqual(expect.objectContaining({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'done' },
    }))
    expect(own).toContainEqual({ sessionUpdate: 'usage_update', size: 128_000, used: 42 })
    const thought = own.find(update => update.sessionUpdate === 'agent_thought_chunk')
    const message = own.find(update => update.sessionUpdate === 'agent_message_chunk')
    expect(thought).toEqual(expect.objectContaining({ messageId: expect.stringMatching(/:thought$/) }))
    expect(message).toEqual(expect.objectContaining({ messageId: expect.any(String) }))
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
      update: expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello from dsh' },
      }),
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
    const approvalController = new AbortController()

    await expect(harness.ctx.approval.request({
      agent,
      toolName: 'bash',
      callId: ToolCallId('call-1'),
      signal: approvalController.signal,
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

    vi.spyOn(harness.ctx.llm, 'resolveCallConfig').mockResolvedValueOnce({
      provider: 'mock', model: 'mock', reasoningEffort: 'high' as never,
    })
    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: MODEL_CONFIG_ID,
      value: 'mock:mock',
    })).resolves.toHaveProperty('configOptions')
  })

  it('selects reasoning effort independently and resets it when the model changes', async () => {
    harness = await makeHarness([reasoningResponse()])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(created.configOptions).toContainEqual(expect.objectContaining({
      id: REASONING_CONFIG_ID,
      category: 'thought_level',
      currentValue: 'default',
    }))
    const selected = await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: REASONING_CONFIG_ID,
      value: encodeReasoningValue('high'),
    })
    expect(selected.configOptions).toContainEqual(expect.objectContaining({
      id: REASONING_CONFIG_ID,
      currentValue: 'effort:high',
    }))
    await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'think' }],
    })
    expect(harness.adapter.requests[0]).toMatchObject({ reasoningEffort: 'high' })

    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: REASONING_CONFIG_ID,
      value: 'effort:unknown',
    })).rejects.toThrow(/unknown reasoning effort/)
    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: REASONING_CONFIG_ID,
      type: 'boolean',
      value: true,
    })).rejects.toThrow(/reasoning configuration requires a select value/)
    vi.spyOn(harness.ctx.llm, 'resolveCallConfig').mockRejectedValueOnce(new Error('effort offline'))
    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: REASONING_CONFIG_ID,
      value: encodeReasoningValue('high'),
    })).rejects.toThrow(/reasoning effort is unavailable.*effort offline/)
    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: REASONING_CONFIG_ID,
      value: 'default',
    })).resolves.toHaveProperty('configOptions')
  })

  it('projects plan/default modes and routes user questions through ACP form elicitation', async () => {
    harness = await makeHarness([])
    await harness.ctx.plugin(UserQuestionService)
    await harness.ctx.plugin(PlanModeController, { section: 'Plan carefully.' })
    await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { elicitation: { form: {} } },
    })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    expect(created.modes).toMatchObject({ currentModeId: 'default' })
    await expect(harness.client.setSessionMode({ sessionId: created.sessionId, modeId: 'plan' }))
      .resolves.toEqual({})
    expect(harness.updates.map(item => item.update)).toContainEqual({
      sessionUpdate: 'current_mode_update', currentModeId: 'plan',
    })
    await harness.client.setSessionMode({ sessionId: created.sessionId, modeId: 'default' })
    await vi.waitFor(() => {
      expect(harness!.updates.map(item => item.update)).toContainEqual({
        sessionUpdate: 'current_mode_update', currentModeId: 'default',
      })
    })

    const agent = harness.ctx.agents.get(SessionId(created.sessionId))
    if (agent === undefined) throw new Error('missing bridge-owned agent')
    harness.onElicitation = () => ({
      action: 'accept',
      content: { q0: 'Fast', q0_custom: 'Use the cached path.' },
    })
    await expect(harness.ctx.userQuestions.ask({
      agent,
      questions: [{
        id: 'route',
        header: 'Route',
        question: 'Which route?',
        options: [{ label: 'Fast', description: 'Use the fast route.' }, { label: 'Safe' }],
      }],
    })).resolves.toEqual({
      answers: [{ id: 'route', selected: ['Fast'], custom: 'Use the cached path.' }],
    })
    expect(harness.elicitationRequests[0]).toMatchObject({
      mode: 'form',
      sessionId: created.sessionId,
      requestedSchema: { required: [] },
    })
    // A request carrying no owning agent is not claimed by this connection's
    // answerer, so the user-questions service reports its terminal NO_PROVIDER
    // rather than an ACP-owned foreign-agent rejection.
    await expect(harness.ctx.userQuestions.ask({
      questions: [{ id: 'foreign', question: 'No owner?' }],
    })).rejects.toMatchObject({ code: 'NO_PROVIDER' })
    await expect(harness.client.setSessionMode({ sessionId: created.sessionId, modeId: 'missing' }))
      .rejects.toThrow(/unknown session mode/)
  })

  it('rejects session mode changes when plan mode is not composed', async () => {
    harness = await makeHarness([])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(harness.client.setSessionMode({ sessionId: created.sessionId, modeId: 'plan' }))
      .rejects.toThrow(/session modes are unavailable/)
  })

  it('routes permission configuration through the session command and applies a running switch', async () => {
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
    const runningSwitch = await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: PERMISSION_CONFIG_ID,
      value: 'workspace-write',
    })
    expect(runningSwitch.configOptions).toContainEqual(expect.objectContaining({
      id: PERMISSION_CONFIG_ID,
      currentValue: 'workspace-write',
    }))
    await vi.waitFor(() => {
      expect(harness!.updates).toContainEqual(expect.objectContaining({
        update: expect.objectContaining({ sessionUpdate: 'config_option_update' }),
      }))
    })
    await harness.client.cancel({ sessionId: created.sessionId })
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('keeps a running step on its assembled model and applies a switch to the next turn', async () => {
    harness = await makeHarness(['hang', reasoningResponse()])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const created = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const running = harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'start on mock' }],
    })
    await vi.waitFor(() => { expect(harness!.adapter.requests).toHaveLength(1) })
    await harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: MODEL_CONFIG_ID,
      value: 'mock:alternate',
    })
    expect(harness.adapter.requests[0]).toMatchObject({ model: 'mock' })
    await harness.client.cancel({ sessionId: created.sessionId })
    await expect(running).resolves.toEqual({ stopReason: 'cancelled' })
    await harness.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'use alternate' }],
    })
    expect(harness.adapter.requests[1]).toMatchObject({ model: 'alternate' })
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
    const resolveConfig = vi.spyOn(harness.ctx.llm, 'resolveCallConfig').mockReturnValueOnce(deferred.promise)
    const selecting = harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: MODEL_CONFIG_ID,
      value: 'mock:alternate',
    })
    await vi.waitFor(() => { expect(resolveConfig).toHaveBeenCalled() })
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
      type: 'boolean',
      value: true,
    })).rejects.toThrow(/permission configuration requires a select value/)
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
    harness.ctx.commands.register({
      name: 'permission',
      description: 'Reject permission',
      input: { hint: '<preset>' },
      handler: () => ({ kind: 'error', text: 'preset rejected' }),
    })
    await expect(harness.client.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: PERMISSION_CONFIG_ID,
      value: 'safe',
    })).rejects.toThrow(/preset rejected/)

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

  it('admits resource links and rejects unsupported rich prompt blocks', async () => {
    harness = await makeHarness([reasoningResponse()])
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'resource_link', name: 'file', uri: 'file:///tmp/a' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    expect(harness.adapter.requests[0]?.messages.at(-1)).toMatchObject({
      content: [{ type: 'text', text: '\n[resource_link name="file" uri="file:///tmp/a"]\n' }],
    })
    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'audio', data: 'AQ==', mimeType: 'audio/wav' }],
    })).rejects.toThrow(/audio prompt content is not supported/)
  })

  it('persists inline images as durable references and replays verified bytes', async () => {
    harness = await makeHarness([reasoningResponse()])
    await harness.ctx.plugin(HarnessAttachments)
    await harness.ctx.plugin(PlanModeController, { section: 'Plan carefully.' })
    const initialized = await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    expect(initialized.agentCapabilities?.promptCapabilities?.image).toBe(true)
    const cwd = process.cwd()
    const { sessionId } = await harness.client.newSession({ cwd, mcpServers: [] })
    await harness.client.prompt({
      sessionId,
      prompt: [
        { type: 'text', text: 'inspect ' },
        { type: 'image', data: 'AQ==', mimeType: 'image/png' },
        { type: 'text', text: 'this' },
      ],
    })
    const requestContent = harness.adapter.requests[0]?.messages.at(-1)?.content
    expect(requestContent?.[0]).toEqual({ type: 'text', text: 'inspect ' })
    const requestImage = requestContent?.[1]
    if (requestImage?.type !== 'image') throw new Error('missing request image')
    expect(requestImage.attachment).toMatchObject({ mediaType: 'image/png', bytes: 1 })
    expect(requestContent?.[2]).toEqual({ type: 'text', text: 'this' })
    const agent = harness.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error('missing bridge-owned agent')
    const image = agent.session.snapshotEvents()
      .find(event => event.type === 'user/message')
      ?.data.content.find(block => block.type === 'image')
    if (image?.type !== 'image') throw new Error('missing durable image reference')
    agent.session.append('assistant/message', {
      turn: 2,
      step: 1,
      message: {
        id: 'assistant-image' as never,
        role: 'assistant',
        content: [{ type: 'image', attachment: image.attachment }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      },
      stream: [],
    }, { surfaceOp: 'append' })
    await vi.waitFor(() => {
      expect(harness!.updates).toContainEqual({
        sessionId,
        update: expect.objectContaining({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'image', data: 'AQ==', mimeType: 'image/png' },
        }),
      })
    })
    const warnings: string[] = []
    harness.ctx.logger.warn = (message: string) => { warnings.push(message) }
    agent.session.append('assistant/message', {
      turn: 2,
      step: 2,
      message: {
        id: 'missing-assistant-image' as never,
        role: 'assistant',
        content: [{
          type: 'image',
          attachment: { ...image.attachment, attachmentId: AttachmentId('missing-image') },
        }],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      },
      stream: [],
    }, { surfaceOp: 'append' })
    await vi.waitFor(() => {
      expect(warnings.some(message => message.includes('image projection failed'))).toBe(true)
    })
    harness.persisted.set(SessionId(sessionId), {
      meta: structuredClone(agent.session.header),
      events: structuredClone(agent.session.snapshotEvents()).filter(event => event.type !== 'assistant/message'
        || event.data.message.id !== 'missing-assistant-image'),
    })
    await harness.client.closeSession({ sessionId })
    harness.updates.length = 0
    const loaded = await harness.client.loadSession({ sessionId, cwd, mcpServers: [] })
    expect(loaded.modes).toMatchObject({ currentModeId: 'default' })
    expect(harness.updates).toContainEqual({
      sessionId,
      update: expect.objectContaining({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'image', data: 'AQ==', mimeType: 'image/png' },
      }),
    })
    await harness.client.closeSession({ sessionId })
    const resumed = await harness.client.resumeSession({ sessionId, cwd })
    expect(resumed.modes).toMatchObject({ currentModeId: 'default' })
    await harness.client.closeSession({ sessionId })
    const persisted = harness.persisted.get(SessionId(sessionId))
    if (persisted === undefined) throw new Error('missing persisted image session')
    const persistedImage = persisted.events
      .find(event => event.type === 'user/message')
      ?.data.content.find(block => block.type === 'image')
    if (persistedImage?.type !== 'image') throw new Error('missing persisted image')
    Object.assign(persistedImage.attachment, { attachmentId: AttachmentId('missing-history-image') })
    await expect(harness.client.loadSession({ sessionId, cwd, mcpServers: [] }))
      .rejects.toThrow(/session history projection failed.*attachment is unavailable or corrupt/)
  })

  it('cancels image admission and maps storage failure to an internal prompt error', async () => {
    harness = await makeHarness([])
    await harness.ctx.plugin(HarnessAttachments)
    await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    const deferred = Promise.withResolvers<readonly ImageAttachmentRef[]>()
    const save = vi.spyOn(harness.ctx.attachments, 'saveImages').mockReturnValueOnce(deferred.promise)
    const pending = harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })
    await vi.waitFor(() => { expect(save).toHaveBeenCalled() })
    await harness.client.cancel({ sessionId })
    deferred.resolve([])
    await expect(pending).resolves.toEqual({ stopReason: 'cancelled' })

    save.mockRejectedValueOnce(new Error('disk failed'))
    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'image', data: 'AQ==', mimeType: 'image/png' }],
    })).rejects.toThrow(/unable to persist the prompt image batch/)
  })
})
