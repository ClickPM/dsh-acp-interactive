import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, type SessionNotification } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { SubagentRunId, type SubagentRunEndInfo, type SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import * as spawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as toolSubagent from '@deepseek-ai/dsh-tool-subagent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import {
  DELEGATION_META_KEY,
  isDelegatedSession,
  MAX_TRANSCRIPT_ENTRIES,
  SubagentCard,
  SubagentTracker,
} from '../src/subagents.js'
import { makeHarness, textResponse, type BridgeHarness, type ScriptEntry } from './harness.js'

type Update = SessionNotification['update']
type ToolCallUpdate = Extract<Update, { sessionUpdate: 'tool_call_update' }>

function toolCall(id: string, name: string, args: string, index = 0): StreamChunk[] {
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: ToolCallId(id), name, argumentsDelta: args },
    { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(id), name, arguments: args } },
  ]
}

function delegate(id: string, description: string, prompt: string): StreamChunk[] {
  return [
    ...toolCall(id, 'subagent', JSON.stringify({ description, prompt })),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function delegatePair(): StreamChunk[] {
  return [
    ...toolCall('delegate-a', 'subagent', JSON.stringify({ description: 'Alpha task', prompt: 'alpha' }), 0),
    ...toolCall('delegate-b', 'subagent', JSON.stringify({ description: 'Beta task', prompt: 'beta' }), 1),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function callEcho(id: string, text: string): StreamChunk[] {
  return [...toolCall(id, 'echo', JSON.stringify({ text })), { type: 'finish', reason: { kind: 'tool-calls' } }]
}

/**
 * The delegated prompt is the child's only human-sourced message; the runtime
 * context the harness appends for a delegated child is plugin-sourced.
 */
function delegatedPrompt(options: GenerateOptions): string {
  const message = options.messages.find(candidate => candidate.role === 'user' && candidate.source?.kind === 'user')
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? ''
}

function messageText(message: GenerateOptions['messages'][number]): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** Deterministic route for concurrent parent + async child activations on MockAdapter. */
function routeTurns(
  handler: (
    last: GenerateOptions['messages'][number] | undefined,
    lastText: string,
    hasUserText: (text: string) => boolean,
  ) => StreamChunk[] | 'hang',
): ScriptEntry[] {
  const entry: ScriptEntry = (options) => {
    const conversational = options.messages.filter(candidate => (
      candidate.role === 'tool'
      || (candidate.role === 'user' && (candidate.source?.kind === 'user' || candidate.source?.kind === 'subagent-settled'))
    ))
    const last = conversational.at(-1)
    const lastText = last === undefined ? '' : messageText(last)
    const hasUserText = (text: string): boolean => conversational.some(
      candidate => candidate.role === 'user' && messageText(candidate).startsWith(text),
    )
    return handler(last, lastText, hasUserText)
  }
  return Array.from({ length: 12 }, () => entry)
}

async function newSession(harness: BridgeHarness): Promise<string> {
  await harness.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
  return (await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })).sessionId
}

async function composeSubagents(harness: BridgeHarness): Promise<void> {
  await harness.ctx.plugin(SubagentRuntime)
  await harness.ctx.plugin(spawnProvider, { providerName: 'spawn' })
  await harness.ctx.plugin(toolSubagent, {
    provider: 'spawn',
    toolName: 'subagent',
    maxDepth: 3,
  })
  harness.ctx.tools.register(defineContentToolFixture({
    name: 'echo',
    description: 'Echo text',
    parameters: { text: { type: 'string' } },
    presentCall: args => ({ card: 'generic', title: `Echo ${args.text}`, kind: 'other' }),
    presentResult: (_args, result) => ({ card: 'generic', title: 'Echoed', content: result.content }),
    execute: () => Promise.resolve([{ type: 'text', text: 'echoed' }]),
  }))
}

function ownUpdates(harness: BridgeHarness, sessionId: string): Update[] {
  return harness.updates.filter(item => item.sessionId === sessionId).map(item => item.update)
}

function cardUpdates(updates: Update[], toolCallId: string): ToolCallUpdate[] {
  return updates.filter((update): update is ToolCallUpdate => (
    update.sessionUpdate === 'tool_call_update' && update.toolCallId === toolCallId
  ))
}

function transcript(update: ToolCallUpdate): string {
  const block = update.content?.[0]
  if (block?.type !== 'content' || block.content.type !== 'text') throw new Error('card has no transcript block')
  return block.content.text
}

function resultText(update: ToolCallUpdate, index: number): string {
  const block = update.content?.[index]
  if (block?.type !== 'content' || block.content.type !== 'text') throw new Error(`card has no text block ${index}`)
  return block.content.text
}

function meta(update: ToolCallUpdate): Record<string, unknown> {
  return update._meta?.[DELEGATION_META_KEY] as Record<string, unknown>
}

describe('interactive ACP subagent projection', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose().catch(() => undefined)
    harness = undefined
  })

  it('folds a foreground delegation into the parent card and settles it with the parent result', async () => {
    harness = await makeHarness(routeTurns((last, lastText) => {
      if (lastText.startsWith('delegate')) return delegate('delegate-1', 'Find auth', 'look for auth')
      if (lastText.startsWith('look for auth')) return callEcho('child-call', 'child')
      if (last?.role === 'tool' && lastText === 'echoed') return textResponse('child answer')
      if (last?.role === 'tool') return textResponse('')
      return textResponse('done')
    }))
    await composeSubagents(harness)
    const sessionId = await newSession(harness)

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'delegate' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })

    const own = ownUpdates(harness, sessionId)
    expect(own).toContainEqual(expect.objectContaining({
      sessionUpdate: 'tool_call', toolCallId: 'delegate-1', title: 'subagent', status: 'in_progress',
    }))
    const cards = cardUpdates(own, 'delegate-1')
    const opened = cards.find(update => update.title === 'Find auth')
    expect(opened).toBeDefined()
    const childId = meta(opened!).session_id as string
    expect(meta(opened!)).toEqual({ session_id: childId, provider: 'spawn', label: 'Find auth' })
    expect(transcript(opened!)).toBe(`Subagent \`spawn\` · session \`${childId}\``)

    const transcripts = cards.map(transcript)
    expect(transcripts.some(text => text.includes('- ▸ Echo child'))).toBe(true)
    expect(transcripts.some(text => text.includes('- ✓ Echoed'))).toBe(true)
    expect(transcripts.some(text => text.includes('- · child answer'))).toBe(true)
    expect(transcripts.some(text => text.includes('- ✓ Subagent completed'))).toBe(true)

    const settled = cards.at(-1)!
    expect(settled.status).toBe('completed')
    expect(transcript(settled)).toContain('- ✓ Subagent completed')
    expect(resultText(settled, 1)).toBe('child answer')
    expect(meta(settled)).toMatchObject({ session_id: childId, stop_reason: 'completed' })

    // The child's text is the parent's tool result, never a top-level message.
    const messages = own.flatMap(update => (
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []
    ))
    expect(messages).not.toContain('child answer')
    expect(messages).toContain('done')
    expect(harness.permissionRequests).toHaveLength(0)

    // The child settled inside the parent's turn and is not an editor session.
    expect(harness.ctx.agents.list().map(agent => agent.id)).toEqual([sessionId])
    expect(harness.persisted.get(SessionId(childId))?.meta).toMatchObject({ origin: 'subagent', parentSession: sessionId })
    const listed = await harness.client.listSessions({})
    expect(listed.sessions.map(session => session.sessionId)).toContain(sessionId)
    expect(listed.sessions.map(session => session.sessionId)).not.toContain(childId)
    await expect(harness.client.loadSession({ sessionId: childId, cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow(/subagent child/)
    await expect(harness.client.resumeSession({ sessionId: childId, cwd: process.cwd(), mcpServers: [] }))
      .rejects.toThrow(/subagent child/)
  })

  it('attributes parallel delegations from one step to their own cards', async () => {
    harness = await makeHarness(routeTurns((last, lastText) => {
      if (lastText.startsWith('fan out')) return delegatePair()
      if (last?.role === 'user' && lastText.startsWith('alpha')) return textResponse('answer alpha')
      if (last?.role === 'user' && lastText.startsWith('beta')) return textResponse('answer beta')
      if (last?.role === 'tool') return textResponse('')
      return textResponse('done')
    }))
    await composeSubagents(harness)
    const sessionId = await newSession(harness)

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'fan out' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })

    const own = ownUpdates(harness, sessionId)
    const alpha = cardUpdates(own, 'delegate-a').at(-1)!
    const beta = cardUpdates(own, 'delegate-b').at(-1)!
    expect(resultText(alpha, 1)).toBe('answer alpha')
    expect(resultText(beta, 1)).toBe('answer beta')
    expect(transcript(alpha)).toContain('- · answer alpha')
    expect(transcript(alpha)).not.toContain('answer beta')
    expect(transcript(beta)).toContain('- · answer beta')
    expect(meta(alpha).session_id).not.toBe(meta(beta).session_id)
    expect(cardUpdates(own, 'delegate-a').find(update => update.title === 'Alpha task')).toBeDefined()
    expect(cardUpdates(own, 'delegate-b').find(update => update.title === 'Beta task')).toBeDefined()
    expect(harness.ctx.agents.list().map(agent => agent.id)).toEqual([sessionId])

    // Lifecycle edges for children nobody attributed, and an agentless dispatch, change nothing.
    const before = harness.updates.length
    const emit = harness.ctx as unknown as { emit(name: string, ...args: unknown[]): void }
    emit.emit('subagent/start', {
      runId: SubagentRunId('stray'), provider: 'spawn', parentSessionId: SessionId(sessionId), id: SessionId('stray'), local: true,
    })
    emit.emit('subagent/end', {
      runId: SubagentRunId('stray'), provider: 'spawn', parentSessionId: SessionId(sessionId), id: SessionId('stray'), local: true, stopReason: 'completed',
    })
    await harness.ctx.tools.execute({
      calls: [{ type: 'tool-call', id: ToolCallId('direct'), name: 'echo', arguments: JSON.stringify({ text: 'direct' }) }],
      signal: new AbortController().signal,
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(harness.updates).toHaveLength(before)
  })

  it('renders nested delegations under the direct child', async () => {
    const innerEnded = Promise.withResolvers<void>()
    harness = await makeHarness(routeTurns((last, lastText, hasUserText) => {
      if (lastText.startsWith('nest')) return delegate('delegate-1', 'Outer', 'outer')
      if (lastText.startsWith('outer')) return delegate('nested-1', 'Inner', 'inner')
      if (lastText.startsWith('inner')) return textResponse('deep answer')
      if (last?.role === 'user' && last.source?.kind === 'subagent-settled' && hasUserText('outer') && !hasUserText('nest')) {
        return textResponse('outer answer')
      }
      if (last?.role === 'tool') return textResponse('')
      return textResponse('done')
    }))
    await composeSubagents(harness)
    harness.ctx.on('subagent/end', (info) => {
      if (harness!.ctx.agents.get(info.parentSessionId)?.session.header.origin === 'subagent') {
        innerEnded.resolve()
      }
    })
    const stream = harness.adapter.stream.bind(harness.adapter)
    vi.spyOn(harness.adapter, 'stream').mockImplementation(async function* (options) {
      const last = options.messages.at(-1)
      const isOuterToolTurn = last?.role === 'tool'
        && options.messages.some(m => m.role === 'user' && messageText(m).startsWith('outer'))
        && !options.messages.some(m => m.role === 'user' && messageText(m).startsWith('nest'))
      if (isOuterToolTurn) await innerEnded.promise
      yield* stream(options)
    })
    const sessionId = await newSession(harness)

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'nest' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })

    const cards = cardUpdates(ownUpdates(harness, sessionId), 'delegate-1')
    expect(cards.map(transcript).some(text => text.includes('- ▸ Subagent `spawn`: Inner'))).toBe(true)
    const settled = cards.at(-1)!
    expect(settled.status).toBe('completed')
    expect(transcript(settled).split('\n')).toEqual([
      expect.stringMatching(/^Subagent `spawn` · session `/),
      '- ✓ Subagent `spawn`: Inner',
      '  - · deep answer',
      '  - ✓ Subagent completed',
      '- · outer answer',
      '- ✓ Subagent completed',
    ])
    expect(resultText(settled, 1)).toBe('outer answer')
    expect(harness.ctx.agents.list().map(agent => agent.id)).toEqual([sessionId])
  })

  it('cancels the child inside the parent turn and suppresses late child events', async () => {
    harness = await makeHarness(routeTurns((last, lastText) => {
      if (lastText.startsWith('delegate')) return delegate('delegate-1', 'Slow task', 'wait')
      if (lastText.startsWith('wait')) return 'hang'
      if (last?.role === 'tool') return textResponse('')
      return textResponse('done')
    }))
    await composeSubagents(harness)
    const sessionId = await newSession(harness)

    const warnings: string[] = []
    harness.ctx.logger.warn = (message: string) => { warnings.push(message) }
    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'delegate' }] })
    await vi.waitFor(() => { expect(harness!.ctx.agents.list()).toHaveLength(2) })
    const child = harness.ctx.agents.list().find(agent => agent.id !== sessionId)!
    await vi.waitFor(() => {
      expect(cardUpdates(ownUpdates(harness!, sessionId), 'delegate-1').some(update => update.title === 'Slow task')).toBe(true)
    })

    // A malformed child event is contained while the child is still linked.
    harness.ctx.emit('session/event', Session.create(child.id), {
      type: 'tool/result', seq: SessionSeq(98), time: 1, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: null as never },
    })
    expect(warnings.some(message => message.includes('subagent event projection failed'))).toBe(true)

    await harness.client.cancel({ sessionId })
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })

    await vi.waitFor(() => {
      expect(harness!.ctx.agents.list().map(agent => agent.id)).toEqual([sessionId])
      expect(cardUpdates(ownUpdates(harness!, sessionId), 'delegate-1').at(-1)?.status).toBe('failed')
    })
    const cards = cardUpdates(ownUpdates(harness, sessionId), 'delegate-1')
    const settled = cards.at(-1)!
    expect(settled.status).toBe('failed')
    expect(transcript(settled)).toContain('- ✗ Subagent aborted')
    expect(meta(settled)).toMatchObject({ stop_reason: 'aborted' })

    const before = harness.updates.length
    harness.ctx.emit('session/event', Session.create(child.id), {
      type: 'tool/call', seq: SessionSeq(99), time: 1,
      data: { turn: 1, step: 1, callId: ToolCallId('late'), name: 'echo', arguments: '{}' },
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(harness.updates).toHaveLength(before)
  })

  it('contains a faulty child presenter as a warning', async () => {
    harness = await makeHarness(routeTurns((last, lastText) => {
      if (lastText.startsWith('delegate')) return delegate('delegate-1', 'Broken card', 'use the broken tool')
      if (lastText.startsWith('use the broken tool')) {
        return [...toolCall('child-call', 'broken-card', '{"text":"x"}'), { type: 'finish', reason: { kind: 'tool-calls' } }]
      }
      if (last?.role === 'tool' && lastText === 'ran') return textResponse('child answer')
      if (last?.role === 'tool') return textResponse('')
      return textResponse('done')
    }))
    await composeSubagents(harness)
    harness.ctx.tools.register(defineContentToolFixture({
      name: 'broken-card',
      description: 'Broken presenter',
      parameters: { text: { type: 'string' } },
      presentCall: () => { throw new Error('presenter failed') },
      execute: () => Promise.resolve([{ type: 'text', text: 'ran' }]),
    }))
    const warnings: string[] = []
    harness.ctx.logger.warn = (message: string) => { warnings.push(message) }
    const sessionId = await newSession(harness)

    await expect(harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'delegate' }] }))
      .resolves.toEqual({ stopReason: 'end_turn' })
    expect(warnings.some(message => message.includes('"broken-card" presentCall failed'))).toBe(true)
    const settled = cardUpdates(ownUpdates(harness, sessionId), 'delegate-1').at(-1)!
    expect(settled.status).toBe('completed')
    expect(transcript(settled)).toContain('- ✓ broken-card')
  })

  it('tears the child down with the parent when the bridge is disposed', async () => {
    harness = await makeHarness(routeTurns((last, lastText) => {
      if (lastText.startsWith('delegate')) return delegate('delegate-1', 'Slow task', 'wait')
      if (lastText.startsWith('wait')) return 'hang'
      if (last?.role === 'tool') return textResponse('')
      return textResponse('done')
    }))
    await composeSubagents(harness)
    const sessionId = await newSession(harness)

    const prompt = harness.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'delegate' }] })
    await vi.waitFor(() => { expect(harness!.ctx.agents.list()).toHaveLength(2) })
    await harness.acpFiber.dispose()
    await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' })
    expect(harness.ctx.agents.list()).toEqual([])
  })
})

describe('subagent tracker', () => {
  const tools = { get: () => undefined }
  const warnings: string[] = []
  const tracker = (): SubagentTracker => new SubagentTracker(tools, message => { warnings.push(message) })

  function agent(id: string, parentSession?: string): Agent {
    return {
      id: SessionId(id),
      session: { id: SessionId(id), header: { id: SessionId(id), parentSession } },
    } as unknown as Agent
  }

  function startInfo(id: string, provider = 'spawn', parentSessionId = 'root'): SubagentRunInfo {
    return { runId: SubagentRunId(`run-${id}`), provider, parentSessionId: SessionId(parentSessionId), id: SessionId(id), local: true }
  }

  function endInfo(id: string, stopReason: SubagentRunEndInfo['stopReason']): SubagentRunEndInfo {
    return { ...startInfo(id), stopReason }
  }

  function session(id: string): Session {
    return { id: SessionId(id) } as Session
  }

  function callEvent(callId: string, name = 'echo'): SessionEvent {
    return {
      type: 'tool/call', seq: SessionSeq(1), time: 1,
      data: { turn: 1, step: 1, callId: ToolCallId(callId), name, arguments: '{"text":"x"}' },
    }
  }

  function resultEvent(callId: string, isError = false, surfaceOp: 'append' | 'replace' = 'append'): SessionEvent {
    return {
      type: 'tool/result', seq: SessionSeq(2), time: 2, surfaceOp,
      data: {
        turn: 1, step: 1,
        message: { role: 'tool', toolCallId: ToolCallId(callId), content: [{ type: 'text', text: 'ok' }], isError },
      },
    } as never
  }

  function textEvent(text: string): SessionEvent {
    return {
      type: 'assistant/message', seq: SessionSeq(3), time: 3, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text }] } },
    } as never
  }

  it('attributes only children started inside a tool execution below a root', () => {
    const tracked = tracker()
    const root = agent('root')
    const child = agent('child', 'root')
    const isRoot = (candidate: Agent): boolean => candidate === root
    expect(tracked.start(startInfo('child'), child, isRoot)).toBeUndefined()
    expect(tracked.runDelegation({ agent: root, callId: ToolCallId('c1') }, () => (
      tracked.start(startInfo('child'), undefined, isRoot)
    ))).toBeUndefined()
    expect(tracked.runDelegation({ agent: root, callId: ToolCallId('c1') }, () => (
      tracked.start(startInfo('other'), agent('other', 'elsewhere'), isRoot)
    ))).toBeUndefined()
    expect(tracked.runDelegation({ agent: agent('stranger'), callId: ToolCallId('c1') }, () => (
      tracked.start(startInfo('child'), agent('child', 'stranger'), isRoot)
    ))).toBeUndefined()
    expect(tracked.end(endInfo('child', 'completed'))).toBeUndefined()
    expect(tracked.childEvent(session('child'), callEvent('x'))).toBeUndefined()
    expect(tracked.settle(root, ToolCallId('c1'))).toBeUndefined()

    tracked.catalog({ version: 0, childId: SessionId('child'), childCreatedAt: 1, mode: 'one-shot', label: 'Label' })
    const opened = tracked.runDelegation({ agent: root, callId: ToolCallId('c1') }, () => (
      tracked.start(startInfo('child'), child, isRoot)
    ))!
    expect(opened.update).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      title: 'Label',
      content: [{ type: 'content', content: { type: 'text', text: 'Subagent `spawn` · session `child`' } }],
      _meta: { [DELEGATION_META_KEY]: { session_id: 'child', provider: 'spawn', label: 'Label' } },
    })

    // A second start on the same call replaces the first card and unlinks its child.
    const replaced = tracked.runDelegation({ agent: root, callId: ToolCallId('c1') }, () => (
      tracked.start(startInfo('child-2'), agent('child-2', 'root'), isRoot)
    ))!
    expect(replaced.card).not.toBe(opened.card)
    expect(replaced.update.title).toBeUndefined()
    expect(tracked.childEvent(session('child'), callEvent('x'))).toBeUndefined()
    expect(tracked.settle(root, ToolCallId('c1'))).toBe(replaced.card)
    expect(tracked.childEvent(session('child-2'), callEvent('x'))).toBeUndefined()
  })

  it('folds child events, nested starts, and settlement into one bounded transcript', () => {
    const tracked = tracker()
    const root = agent('root')
    const child = agent('child', 'root')
    const isRoot = (candidate: Agent): boolean => candidate === root
    const opened = tracked.runDelegation({ agent: root, callId: ToolCallId('c1') }, () => (
      tracked.start(startInfo('child'), child, isRoot)
    ))!

    expect(tracked.childEvent(session('child'), resultEvent('x', false, 'replace'))).toBeUndefined()
    expect(tracked.childEvent(session('child'), { type: 'turn/end', seq: SessionSeq(4), time: 4, data: { turn: 1, reason: { kind: 'completed' } } } as never)).toBeUndefined()
    expect(tracked.childEvent(session('child'), textEvent('   '))).toBeUndefined()

    tracked.childEvent(session('child'), callEvent('grand-call', 'subagent'))
    const nested = tracked.runDelegation({ agent: child, callId: ToolCallId('grand-call') }, () => (
      tracked.start(startInfo('grand', 'fork'), agent('grand', 'child'), isRoot)
    ))!
    expect(nested.card).toBe(opened.card)
    expect(tracked.childEvent(session('grand'), textEvent('deep'))?.card).toBe(opened.card)
    expect(tracked.end(endInfo('grand', 'max-tokens'))?.card).toBe(opened.card)
    expect(tracked.childEvent(session('child'), resultEvent('grand-call', true))?.card).toBe(opened.card)
    expect(tracked.childEvent(session('child'), textEvent('long ' + 'x'.repeat(200)))?.card).toBe(opened.card)
    tracked.end(endInfo('child', 'aborted'))

    const lines = opened.card.render().split('\n')
    expect(lines).toEqual([
      'Subagent `spawn` · session `child`',
      '- ✗ Subagent `fork`',
      '  - · deep',
      '  - ✗ Subagent max-tokens',
      `- · long ${'x'.repeat(154)}…`,
      '- ✗ Subagent aborted',
    ])
    // `- · ` plus 160 characters: 159 kept plus the ellipsis.
    expect(lines[4]).toHaveLength(164)
    expect(opened.card.progress()._meta).toEqual({
      [DELEGATION_META_KEY]: { session_id: 'child', provider: 'spawn', stop_reason: 'aborted' },
    })

    // A settled result keeps the transcript ahead of the tool's own content and metadata.
    expect(opened.card.settle({
      sessionUpdate: 'tool_call_update', toolCallId: ToolCallId('c1'), status: 'failed', _meta: { other: 1 },
    })).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'c1',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: opened.card.render() } }],
      _meta: { other: 1, [DELEGATION_META_KEY]: { session_id: 'child', provider: 'spawn', stop_reason: 'aborted' } },
    })

    // Bounded: the oldest entries fold into one elision line, and settled keys that folded away are ignored.
    for (let index = 0; index < MAX_TRANSCRIPT_ENTRIES; index += 1) {
      tracked.childEvent(session('child'), callEvent(`call-${index}`))
    }
    tracked.childEvent(session('child'), resultEvent('grand-call'))
    opened.card.retitle('missing', 'ignored')
    const bounded = opened.card.render().split('\n')
    expect(bounded).toHaveLength(MAX_TRANSCRIPT_ENTRIES + 2)
    expect(bounded[1]).toBe('- … 5 earlier entries omitted')
    // Without a tool-owned presenter, the generic card title is the tool name.
    expect(bounded.at(-1)).toBe('- ▸ echo')
  })

  it('forgets cards and links when their agents are disposed', () => {
    const tracked = tracker()
    const root = agent('root')
    const child = agent('child', 'root')
    const isRoot = (candidate: Agent): boolean => candidate === root
    tracked.runDelegation({ agent: root, callId: ToolCallId('c1') }, () => tracked.start(startInfo('child'), child, isRoot))
    tracked.catalog({ version: 0, childId: SessionId('pending'), childCreatedAt: 1, mode: 'continuable', label: 'Pending' })
    // A sibling card on the same root keeps its own links when another settles.
    const sibling = tracked.runDelegation({ agent: root, callId: ToolCallId('c2') }, () => (
      tracked.start(startInfo('sibling'), agent('sibling', 'root'), isRoot)
    ))!
    expect(tracked.settle(root, ToolCallId('c1'))).toBeDefined()
    expect(tracked.childEvent(session('sibling'), callEvent('x'))?.card).toBe(sibling.card)
    expect(tracked.childEvent(session('child'), callEvent('x'))).toBeUndefined()

    tracked.dispose(agent('pending'))
    // Child disposal keeps links intact for trailing subagent/end; root disposal clears all cards and links.
    tracked.dispose(agent('sibling'))
    expect(tracked.end(endInfo('sibling', 'completed'))?.card).toBe(sibling.card)
    tracked.dispose(root)
    expect(tracked.settle(root, ToolCallId('c2'))).toBeUndefined()
    expect(tracked.end(endInfo('child', 'completed'))).toBeUndefined()
    expect(tracked.end(endInfo('sibling', 'completed'))).toBeUndefined()

    const card = new SubagentCard(root, ToolCallId('c2'), SessionId('child'), 'spawn', undefined)
    card.append(1, '▸', 'running', 'k')
    card.complete('k', true)
    card.complete('absent', false, 'ignored')
    expect(card.render()).toBe('Subagent `spawn` · session `child`\n- ✗ running')
    expect(card.opening().title).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('classifies delegated session headers', () => {
    expect(isDelegatedSession({ origin: 'subagent' })).toBe(true)
    expect(isDelegatedSession({})).toBe(false)
  })

  it('covers descriptor fallback, post-start catalog v3 updates, and deferred vs immediate result paths', () => {
    const tracked = tracker()
    const root = agent('root')
    const otherRoot = agent('other-root')
    const isRoot = (candidate: Agent): boolean => candidate === root || candidate === otherRoot

    // Descriptor label fallback with preceding non-descriptor event, and no-descriptor session.
    const childWithDescriptor = {
      id: SessionId('desc-child'),
      session: {
        id: SessionId('desc-child'),
        header: { id: SessionId('desc-child'), parentSession: SessionId('root') },
        snapshotEvents: () => [
          { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } },
          { type: 'subagent/descriptor', seq: SessionSeq(2), time: 2, data: { version: 3, mode: 'continuable', provider: 'spawn', label: 'Desc Label' } },
        ],
      },
    } as unknown as Agent
    const childWithoutDescriptor = {
      id: SessionId('plain-child'),
      session: {
        id: SessionId('plain-child'),
        header: { id: SessionId('plain-child'), parentSession: SessionId('root') },
        snapshotEvents: () => [{ type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } }],
      },
    } as unknown as Agent

    // v3 catalog arriving BEFORE start carries name in identities map.
    tracked.catalog({ version: 3, childId: SessionId('plain-child'), childCreatedAt: 1, mode: 'continuable', label: 'Pre Label', name: 'worker-0' })
    const pre = tracked.runDelegation({ agent: root, callId: ToolCallId('pre-call') }, () => (
      tracked.start(startInfo('plain-child'), childWithoutDescriptor, isRoot)
    ))!
    expect(pre.card.label).toBe('Pre Label')
    expect(meta(pre.update as ToolCallUpdate)).toMatchObject({ name: 'worker-0', label: 'Pre Label' })
    // Unchanged post-start catalog returns undefined.
    expect(tracked.catalog({
      version: 3, childId: SessionId('plain-child'), childCreatedAt: 1, mode: 'continuable', label: 'Pre Label', name: 'worker-0',
    })).toBeUndefined()

    // Direct child started from subagent/descriptor BEFORE subagent/catalog v3 arrives.
    const opened = tracked.runDelegation({ agent: root, callId: ToolCallId('c1') }, () => (
      tracked.start(startInfo('desc-child'), childWithDescriptor, isRoot)
    ))!
    expect(opened.card.label).toBe('Desc Label')
    // Post-start catalog updates name and emits an opening update.
    const updatedCatalog = tracked.catalog({
      version: 3, childId: SessionId('desc-child'), childCreatedAt: 2, mode: 'continuable', label: 'Updated Label', name: 'agent-1',
    })
    expect(updatedCatalog?.update).toMatchObject({
      title: 'Updated Label',
      _meta: { [DELEGATION_META_KEY]: { session_id: 'desc-child', provider: 'spawn', label: 'Updated Label', name: 'agent-1' } },
    })
    // Subsequent catalog changing only label (same name) preserves existing nameValue cleanly.
    const relabeledCard = tracked.catalog({
      version: 3, childId: SessionId('desc-child'), childCreatedAt: 2, mode: 'continuable', label: 'Relabeled Only', name: 'agent-1',
    })
    expect(relabeledCard?.card.label).toBe('Relabeled Only')

    // Descendant started without label then updated once via childEvent('subagent/catalog'), then ignored when unchanged.
    tracked.childEvent(session('desc-child'), callEvent('nested-call', 'subagent'))
    const grand = {
      id: SessionId('grand'),
      session: {
        id: SessionId('grand'),
        header: { id: SessionId('grand'), parentSession: SessionId('desc-child') },
        snapshotEvents: () => [{ type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } }],
      },
    } as unknown as Agent
    tracked.runDelegation({ agent: childWithDescriptor, callId: ToolCallId('nested-call') }, () => (
      tracked.start(startInfo('grand', 'spawn', 'desc-child'), grand, isRoot)
    ))
    const retitled = tracked.childEvent(session('desc-child'), {
      type: 'subagent/catalog', seq: SessionSeq(3), time: 3,
      data: { version: 3, childId: SessionId('grand'), childCreatedAt: 3, mode: 'continuable', label: 'Grand Label', name: 'grand-1' },
    })
    expect(retitled?.card.render()).toContain('Subagent `spawn`: Grand Label')
    expect(tracked.childEvent(session('desc-child'), {
      type: 'subagent/catalog', seq: SessionSeq(4), time: 4,
      data: { version: 3, childId: SessionId('grand'), childCreatedAt: 3, mode: 'continuable', label: 'Grand Label', name: 'grand-1' },
    })).toBeUndefined()
    // Updating only label (keeping name unchanged) exercises labelChanged && !nameChanged branch.
    const relabeledOnly = tracked.childEvent(session('desc-child'), {
      type: 'subagent/catalog', seq: SessionSeq(5), time: 5,
      data: { version: 3, childId: SessionId('grand'), childCreatedAt: 3, mode: 'continuable', label: 'Grand Label 2', name: 'grand-1' },
    })
    expect(relabeledOnly?.card.render()).toContain('Subagent `spawn`: Grand Label 2')

    // activeChildIds isolates by root.
    const otherChild = agent('other-child', 'other-root')
    tracked.runDelegation({ agent: otherRoot, callId: ToolCallId('oc') }, () => (
      tracked.start(startInfo('other-child', 'spawn', 'other-root'), otherChild, isRoot)
    ))
    expect(tracked.activeChildIds(root).sort()).toEqual(['desc-child', 'grand', 'plain-child'])
    expect(tracked.activeChildIds(otherRoot)).toEqual(['other-child'])

    // Deferred parentResult when child ends WITHOUT lastAssistantMessage (aborted empty).
    expect(tracked.parentResult(root, ToolCallId('missing'), {
      sessionUpdate: 'tool_call_update', toolCallId: 'missing', status: 'completed',
    }, false)).toBeUndefined()
    const inProgress = tracked.parentResult(root, ToolCallId('c1'), {
      sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', _meta: { tag: 1 },
    }, false)
    expect(inProgress?.status).toBe('in_progress')
    const settledEmptyFail = tracked.end({ ...endInfo('desc-child', 'aborted') })!
    expect(settledEmptyFail.update).toMatchObject({
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: expect.stringContaining('Subagent aborted') } }],
      _meta: { tag: 1, [DELEGATION_META_KEY]: { stop_reason: 'aborted' } },
    })

    // Sync path: end arrives WITH lastAssistantMessage BEFORE non-error parentResult, and aborted outcome.
    tracked.end({
      ...endInfo('plain-child', 'completed'),
      lastAssistantMessage: [{ type: 'text', text: 'sync final answer' }],
    })
    const syncCompleted = tracked.parentResult(root, ToolCallId('pre-call'), {
      sessionUpdate: 'tool_call_update', toolCallId: 'pre-call', status: 'completed',
    }, false)!
    expect(syncCompleted.status).toBe('completed')
    expect((syncCompleted.content?.[1] as { content: { text: string } }).content.text).toBe('sync final answer')

    // Parent tool/result error settles immediately even while child is running.
    const errCard = tracked.runDelegation({ agent: otherRoot, callId: ToolCallId('oc') }, () => (
      tracked.start(startInfo('other-child-2', 'spawn', 'other-root'), agent('other-child-2', 'other-root'), isRoot)
    ))!
    expect(errCard).toBeDefined()
    const failedResult = tracked.parentResult(otherRoot, ToolCallId('oc'), {
      sessionUpdate: 'tool_call_update', toolCallId: 'oc', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'boom' } }],
    }, true)!
    expect(failedResult.status).toBe('failed')

    // Synchronous settle after aborted end updates status to 'failed'.
    const abortCard = new SubagentCard(root, ToolCallId('sync-abort'), SessionId('s-abort'), 'spawn', 'A')
    abortCard.finish(1, 'aborted', [{ type: 'text', text: 'partial' }])
    expect(abortCard.settle({
      sessionUpdate: 'tool_call_update', toolCallId: 'sync-abort', status: 'completed',
    }).status).toBe('failed')
    // Settle before finish leaves original status and undefined outcome.
    const rawCard = new SubagentCard(root, ToolCallId('raw'), SessionId('s-raw'), 'spawn', undefined)
    expect(rawCard.settle({
      sessionUpdate: 'tool_call_update', toolCallId: 'raw', status: 'completed',
    }).status).toBe('completed')
  })
})
