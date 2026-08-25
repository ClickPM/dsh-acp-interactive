import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { deferred, makeHarness, type BridgeHarness } from './harness.js'

async function session(harness: BridgeHarness): Promise<string> {
  await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  return (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
}

describe('interactive ACP connection ownership', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose().catch(() => undefined)
    harness = undefined
  })

  it('disposal cancels a model prompt and shares one quiescence promise', async () => {
    harness = await makeHarness(['hang'])
    const sessionId = await session(harness)
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    await vi.waitFor(() => { expect(harness!.ctx.agents.get(SessionId(sessionId))?.status).toBe('running') })

    await Promise.all([harness.acpFiber.dispose(), harness.acpFiber.dispose()])
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
    await expect(harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).rejects.toThrow(/disposed/)
  })

  it('disposal aborts a command prompt before releasing its session', async () => {
    harness = await makeHarness([])
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
    const sessionId = await session(harness)
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: '/wait' }] })
    await started.promise

    await harness.acpFiber.dispose()
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    expect(harness.ctx.agents.get(SessionId(sessionId))).toBeUndefined()
  })

  it('drains continuable descendants before disposing sessions and contains drain failure', async () => {
    harness = await makeHarness([])
    const order: string[] = []
    let parents: readonly Agent[] = []
    harness.ctx.provide('subagents', {
      drainContinuableDescendants: (value: readonly Agent[]) => {
        parents = value
        order.push('drained')
        return Promise.resolve()
      },
    } as never)
    const sessionId = await session(harness)
    const agent = harness.ctx.agents.get(SessionId(sessionId))!
    harness.ctx.on('agent/disposed', () => { order.push('disposed') })
    await harness.acpFiber.dispose()
    expect(parents).toEqual([agent])
    expect(order).toEqual(['drained', 'disposed'])

    const failing = await makeHarness([])
    try {
      const warnings: string[] = []
      failing.ctx.logger.warn = (message: string) => { warnings.push(message) }
      failing.ctx.provide('subagents', {
        drainContinuableDescendants: () => Promise.reject(new Error('drain failed')),
      } as never)
      const failingId = await session(failing)
      await failing.acpFiber.dispose()
      expect(warnings.some(message => message.includes('continuable subagent teardown failed'))).toBe(true)
      expect(failing.ctx.agents.get(SessionId(failingId))).toBeUndefined()
    } finally {
      await failing.dispose().catch(() => undefined)
    }
  })

  it('awaits all session disposers and reports nested cleanup failure', async () => {
    harness = await makeHarness([])
    const create = harness.ctx.agents.create.bind(harness.ctx.agents)
    const warnings: string[] = []
    let created = 0
    harness.ctx.logger.warn = (message: string) => { warnings.push(message) }
    vi.spyOn(harness.ctx.agents, 'create').mockImplementation(async (options) => {
      const handle = await create(options)
      if (created++ === 0) {
        const dispose = handle.dispose.bind(handle)
        handle.dispose = async () => {
          await dispose()
          throw new Error('cleanup failed', { cause: new Error('sqlite busy') })
        }
      }
      return handle
    })
    await session(harness)
    await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })

    await harness.closeClientTransport()
    await vi.waitFor(() => {
      expect(warnings.some(message => message.includes('teardown failed')
        && message.includes('cleanup failed') && message.includes('sqlite busy'))).toBe(true)
      expect(harness!.ctx.agents.list()).toEqual([])
    })
    const disposed = harness
    harness = undefined
    await disposed.dispose().catch(() => undefined)
  })

  it('client close and failure dispose owned sessions without root-context disposal', async () => {
    harness = await makeHarness([])
    const first = await session(harness)
    await harness.closeClientTransport()
    await vi.waitFor(() => { expect(harness!.ctx.agents.get(SessionId(first))).toBeUndefined() })

    const failed = await makeHarness([])
    try {
      const warnings: string[] = []
      failed.ctx.logger.warn = (message: string) => { warnings.push(message) }
      const second = await session(failed)
      await failed.abortClientTransport()
      await vi.waitFor(() => { expect(failed.ctx.agents.get(SessionId(second))).toBeUndefined() })
      expect(warnings.some(message => message.includes('session/update failed: Error: client transport failed'))).toBe(true)
    } finally {
      await failed.dispose()
    }
  })

  it('disposing a session-less bridge is idempotent', async () => {
    harness = await makeHarness([])
    await Promise.all([harness.acpFiber.dispose(), harness.acpFiber.dispose()])
    expect(harness.ctx.agents.list()).toEqual([])
  })
})
