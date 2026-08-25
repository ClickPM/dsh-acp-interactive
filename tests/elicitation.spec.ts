import { describe, expect, it } from 'vitest'
import type { CreateElicitationRequest, CreateElicitationResponse } from '@agentclientprotocol/sdk'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { acpQuestionProvider } from '../src/elicitation.js'

const agent = { id: 'agent' } as unknown as Agent

function request(questions: AskUserQuestionRequest['questions'], signal?: AbortSignal): AskUserQuestionRequest {
  return { agent, questions, ...signal === undefined ? {} : { signal } }
}

function provider(options: {
  owns?: string
  enabled?: boolean
  create: (wire: CreateElicitationRequest) => Promise<CreateElicitationResponse>
}) {
  return acpQuestionProvider(
    () => options.owns,
    () => options.enabled ?? true,
    options.create,
  )
}

describe('ACP user-question elicitation', () => {
  it('projects free text, single choice, multi-select, details, and custom text', async () => {
    const seen: CreateElicitationRequest[] = []
    const questions: AskUserQuestionRequest['questions'] = [
      { id: 'note', question: 'Add a note?', detail: 'Explain the constraint.' },
      {
        id: 'route', header: 'Route', question: 'Which route?',
        options: [{ label: 'Fast' }, { label: 'Safe', description: 'Recompute.' }],
      },
      {
        id: 'targets', header: 'Targets', question: 'Which targets?', detail: 'Pick all that apply.',
        options: [{ label: 'Tests' }, { label: 'Docs' }], multiSelect: true,
      },
    ]
    const actual = await provider({
      owns: 'session',
      create: (wire) => {
        seen.push(wire)
        return Promise.resolve({
          action: 'accept',
          content: { q0: 'Keep it local.', q1: 'Fast', q1_custom: 'Warm cache.', q2: ['Tests', 'Docs'] },
        })
      },
    }).ask(request(questions))
    expect(actual).toEqual({ answers: [
      { id: 'note', selected: [], custom: 'Keep it local.' },
      { id: 'route', selected: ['Fast'], custom: 'Warm cache.' },
      { id: 'targets', selected: ['Tests', 'Docs'] },
    ] })
    expect(seen[0]).toEqual({
      mode: 'form',
      sessionId: 'session',
      message: 'Add a note?\n\nExplain the constraint.\n\n---\n\nRoute: Which route?\n\n- Fast\n- Safe: Recompute.\n\n---\n\nTargets: Which targets?\n\nPick all that apply.\n\n- Tests\n- Docs',
      requestedSchema: {
        type: 'object',
        properties: {
          q0: { type: 'string', title: 'Add a note?', description: 'Explain the constraint.', minLength: 1 },
          q1: {
            type: 'string', title: 'Route',
            oneOf: [{ const: 'Fast', title: 'Fast' }, { const: 'Safe', title: 'Safe' }],
          },
          q1_custom: {
            type: 'string', title: 'Route — Other',
            description: 'Optional free-text answer when the listed choices are insufficient.',
          },
          q2: {
            type: 'array', title: 'Targets', description: 'Pick all that apply.',
            items: { anyOf: [{ const: 'Tests', title: 'Tests' }, { const: 'Docs', title: 'Docs' }] },
            minItems: 1,
          },
          q2_custom: {
            type: 'string', title: 'Targets — Other',
            description: 'Optional free-text answer when the listed choices are insufficient.',
          },
        },
        required: ['q0'],
      },
    })
  })

  it('fails explicitly for foreign agents, missing capability, dismissal, and invalid answers', async () => {
    const question = request([{
      id: 'route', question: 'Which?', options: [{ label: 'Fast' }],
    }])
    await expect(provider({ create: () => Promise.resolve({ action: 'cancel' }) }).ask(question))
      .rejects.toMatchObject({ code: 'ASK_FOREIGN_AGENT' })
    await expect(provider({ owns: 'session', enabled: false, create: () => Promise.resolve({ action: 'cancel' }) }).ask(question))
      .rejects.toMatchObject({ code: 'NO_PROVIDER' })
    for (const action of ['decline', 'cancel'] as const) {
      await expect(provider({ owns: 'session', create: () => Promise.resolve({ action }) }).ask(question))
        .rejects.toMatchObject({ code: 'ASK_CANCELLED' })
    }
    const unknownOption = provider({
      owns: 'session', create: () => Promise.resolve({ action: 'accept', content: { q0: 'Unknown' } }),
    }).ask(question)
    await expect(unknownOption).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
    await expect(unknownOption).rejects.toThrow(/unknown option/)
    const invalidText = provider({
      owns: 'session', create: () => Promise.resolve({ action: 'accept', content: { q0: 'Fast', q0_custom: 1 as never } }),
    }).ask(question)
    await expect(invalidText).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
    await expect(invalidText).rejects.toThrow(/invalid text/)
    const unanswered = provider({
      owns: 'session', create: () => Promise.resolve({ action: 'accept', content: {} }),
    }).ask(question)
    await expect(unanswered).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
    await expect(unanswered).rejects.toThrow(/did not answer/)
    await expect(provider({
      owns: 'session', create: () => Promise.resolve({ action: 'accept' }),
    }).ask(question)).rejects.toMatchObject({ code: 'INVALID_ANSWER' })
  })

  it('propagates creation failures and distinguishes pre-abort from in-flight cancellation', async () => {
    const questions = [{ id: 'note', question: 'Note?' }]
    await expect(provider({
      owns: 'session', create: () => Promise.reject(new Error('client failed')),
    }).ask(request(questions))).rejects.toThrow(/client failed/)
    const failedWithSignal = new AbortController()
    await expect(provider({
      owns: 'session', create: () => Promise.reject(new Error('signalled client failed')),
    }).ask(request(questions, failedWithSignal.signal))).rejects.toThrow(/signalled client failed/)
    await expect(provider({
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- ACP clients may reject with arbitrary values.
      owns: 'session', create: () => Promise.reject('bare client failure'),
    }).ask(request(questions, failedWithSignal.signal))).rejects.toThrow(/bare client failure/)

    const pre = new AbortController()
    pre.abort(new Error('already cancelled'))
    await expect(provider({
      owns: 'session', create: () => new Promise(() => {}),
    }).ask(request(questions, pre.signal))).rejects.toThrow(/already cancelled/)

    const during = new AbortController()
    const operation = Promise.withResolvers<CreateElicitationResponse>()
    const asking = provider({ owns: 'session', create: () => operation.promise })
      .ask(request(questions, during.signal))
    during.abort()
    await expect(asking).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    operation.resolve({ action: 'accept', content: { q0: 'late' } })
    await operation.promise
  })
})
