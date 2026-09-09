import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type AvailableCommand } from '@agentclientprotocol/sdk'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  makeHarness,
  textResponse,
  type BridgeHarness,
} from './harness.js'

async function newSession(harness: BridgeHarness, cwd = process.cwd()): Promise<string> {
  await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  return (await harness.client.newSession({ cwd, mcpServers: [] })).sessionId
}

function commandSnapshots(harness: BridgeHarness, sessionId: string): AvailableCommand[][] {
  return harness.updates.flatMap(item => item.sessionId === sessionId
    && item.update.sessionUpdate === 'available_commands_update'
    ? [item.update.availableCommands]
    : [])
}

describe('interactive ACP commands and skills', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('advertises only user-invocable skills and invokes one through the normal agent path', async () => {
    harness = await makeHarness([textResponse('skill used')])
    harness.ctx.skills.register({
      name: 'user-only',
      description: 'User-only skill',
      invocation: { modelInvocable: false, userInvocable: true },
      source: 'runtime',
      content: 'Follow the user-only instructions.',
    })
    harness.ctx.skills.register({
      name: 'model-only',
      description: 'Model-only skill',
      invocation: { modelInvocable: true, userInvocable: false },
      source: 'runtime',
      content: 'Model-only instructions.',
    })
    harness.ctx.commands.register({
      name: 'z-command', description: 'Last command', handler: () => ({ kind: 'success' }),
    })
    const sessionId = await newSession(harness)
    await vi.waitFor(() => {
      expect(commandSnapshots(harness!, sessionId).at(-1)).toEqual([
        { name: 'user-only', description: 'User-only skill' },
        { name: 'z-command', description: 'Last command' },
      ])
    })

    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/model-only' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    expect(harness.adapter.requests).toHaveLength(0)

    await expect(harness.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/user-only apply this carefully' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })

    expect(harness.adapter.requests).toHaveLength(1)
    expect(harness.adapter.requests[0]?.messages.some(message => message.content.some(part =>
      part.type === 'text' && part.text.includes('Follow the user-only instructions.'),
    ))).toBe(true)
    expect(harness.adapter.requests[0]?.messages).toContainEqual(expect.objectContaining({
      source: { kind: 'skill-invocation', name: 'user-only', form: 'instructions' },
    }))
    const agent = harness.ctx.agents.get(SessionId(sessionId))
    expect(agent?.session.snapshotEvents().some(event => event.type === 'command/run')).toBe(false)
  })

  it('gives a real command priority over a same-name skill', async () => {
    harness = await makeHarness([])
    harness.ctx.skills.register({
      name: 'shared', description: 'Skill description', source: 'runtime', content: 'Skill body.',
    })
    harness.ctx.commands.register({
      name: 'shared',
      description: 'Command description',
      handler: () => ({ kind: 'success', text: 'command won' }),
    })
    const sessionId = await newSession(harness)
    await vi.waitFor(() => {
      expect(commandSnapshots(harness!, sessionId).at(-1)).toEqual([{
        name: 'shared', description: 'Command description',
      }])
    })

    await expect(harness.client.prompt({
      sessionId, prompt: [{ type: 'text', text: '/shared' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    expect(harness.adapter.requests).toHaveLength(0)
    expect(harness.updates).toContainEqual({
      sessionId,
      update: expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'command won' },
      }),
    })
  })

  it('refreshes the ACP directory when the skill catalog changes', async () => {
    harness = await makeHarness([])
    const sessionId = await newSession(harness)
    await vi.waitFor(() => { expect(commandSnapshots(harness!, sessionId)).toHaveLength(1) })

    const dispose = harness.ctx.skills.register({
      name: 'live-skill', description: 'Live skill', source: 'runtime', content: 'Live body.',
    })
    await vi.waitFor(() => {
      expect(commandSnapshots(harness!, sessionId).at(-1)?.map(command => command.name)).toContain('live-skill')
    })
    dispose()
    await vi.waitFor(() => {
      expect(commandSnapshots(harness!, sessionId).at(-1)?.map(command => command.name)).not.toContain('live-skill')
    })

    const warnings: string[] = []
    harness.ctx.logger.warn = (message: string) => { warnings.push(message) }
    const original = harness.ctx.skills.snapshot.bind(harness.ctx.skills)
    const snapshot = vi.spyOn(harness.ctx.skills, 'snapshot')
    snapshot.mockResolvedValueOnce({
      skills: [{
        name: 'incomplete-skill',
        description: 'Incomplete',
        invocation: { modelInvocable: true, userInvocable: true },
        source: 'runtime',
        provider: 'runtime',
      }],
      complete: false,
    })
    harness.ctx.emit('skills/change')
    await vi.waitFor(() => { expect(snapshot).toHaveBeenCalled() })
    expect(commandSnapshots(harness, sessionId).at(-1)).toEqual([])

    snapshot.mockRejectedValueOnce(new Error('catalog unavailable'))
    harness.ctx.emit('skills/change')
    await vi.waitFor(() => {
      expect(warnings.some(message => message.includes('catalog unavailable'))).toBe(true)
    })
    expect(commandSnapshots(harness, sessionId).at(-1)).toEqual([])
    snapshot.mockImplementation(original)
  })

  it('reports an unknown slash name without starting a model turn', async () => {
    harness = await makeHarness([])
    const sessionId = await newSession(harness)
    await expect(harness.client.prompt({
      sessionId, prompt: [{ type: 'text', text: '/not-a-skill' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    expect(harness.adapter.requests).toHaveLength(0)
    expect(harness.updates).toContainEqual({
      sessionId,
      update: expect.objectContaining({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Error: unknown command: /not-a-skill' },
      }),
    })
    await expect(harness.client.prompt({
      sessionId, prompt: [{ type: 'text', text: '/' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('cancels skill resolution before it can enqueue a user message', async () => {
    harness = await makeHarness([])
    const sessionId = await newSession(harness)
    await vi.waitFor(() => { expect(commandSnapshots(harness!, sessionId)).toHaveLength(1) })
    const original = harness.ctx.skills.get.bind(harness.ctx.skills)
    const started = Promise.withResolvers<undefined>()
    vi.spyOn(harness.ctx.skills, 'get').mockImplementation((name, options = {}) => {
      if (name !== 'slow-skill' || options.signal === undefined) return original(name, options)
      started.resolve(undefined)
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
          reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error('aborted'))
        }, { once: true })
      })
    })

    const prompt = harness.client.prompt({
      sessionId, prompt: [{ type: 'text', text: '/slow-skill' }],
    })
    await started.promise
    await harness.client.cancel({ sessionId })
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    expect(harness.adapter.requests).toHaveLength(0)
    expect(harness.ctx.agents.get(SessionId(sessionId))?.session.snapshotEvents()).toEqual([])
  })

  it('keeps scoped skill directories and invocation routing isolated by session', async () => {
    harness = await makeHarness([textResponse('first used')])
    const firstId = await newSession(harness)
    const secondId = (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
    const first = harness.ctx.agents.get(SessionId(firstId))
    const second = harness.ctx.agents.get(SessionId(secondId))
    if (first === undefined || second === undefined) throw new Error('missing bridge-owned agents')
    await first.ctx.plugin({
      name: 'first-session-skill',
      inject: ['skills'],
      apply: ctx => ctx.skills.register({
        name: 'first-skill', description: 'First session skill', source: 'runtime', content: 'First body.',
      }),
    })
    await second.ctx.plugin({
      name: 'second-session-skill',
      inject: ['skills'],
      apply: ctx => ctx.skills.register({
        name: 'second-skill', description: 'Second session skill', source: 'runtime', content: 'Second body.',
      }),
    })
    await vi.waitFor(() => {
      expect(commandSnapshots(harness!, firstId).at(-1)?.map(command => command.name)).toEqual(['first-skill'])
      expect(commandSnapshots(harness!, secondId).at(-1)?.map(command => command.name)).toEqual(['second-skill'])
    })

    await expect(harness.client.prompt({
      sessionId: secondId, prompt: [{ type: 'text', text: '/first-skill' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    expect(harness.adapter.requests).toHaveLength(0)
    await expect(harness.client.prompt({
      sessionId: firstId, prompt: [{ type: 'text', text: '/first-skill' }],
    })).resolves.toEqual({ stopReason: 'end_turn' })
    expect(harness.adapter.requests).toHaveLength(1)
  })
})
