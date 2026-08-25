import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { admittedCommandText, admitPrompt, InteractivePromptError, projectImage } from '../src/content.js'

const selection = { provider: 'mock', model: 'mock' } satisfies ModelSelection

const ref: ImageAttachmentRef = {
  attachmentId: AttachmentId('image-1'),
  mediaType: 'image/png',
  bytes: 1,
  width: 1,
  height: 1,
}

async function interactiveError(promise: Promise<unknown>): Promise<InteractivePromptError> {
  try {
    await promise
  } catch (error: unknown) {
    if (error instanceof InteractivePromptError) return error
    throw new Error('expected an InteractivePromptError', { cause: error })
  }
  throw new Error('expected the operation to reject')
}

function fixture(options: {
  route?: 'image' | 'text' | Error
  attachments?: {
    saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>
    readImage(reference: ImageAttachmentRef): Promise<{ ref: ImageAttachmentRef; data: Uint8Array }>
  }
  agent?: Partial<Agent>
} = {}): { ctx: Context; agent: Agent } {
  const ctx = {
    llm: {
      resolveModelInfo: () => options.route instanceof Error
        ? Promise.reject(options.route)
        : Promise.resolve({
          provider: 'mock', id: 'mock', name: 'Mock',
          inputModalities: options.route === 'text' ? ['text'] : ['text', 'image'],
        }),
    },
    get: (name: string) => name === 'attachments' ? options.attachments : undefined,
  } as unknown as Context
  return {
    ctx,
    agent: {
      options: {},
      session: { requestHeader: () => undefined },
      ...options.agent,
    } as Agent,
  }
}

describe('interactive ACP prompt admission', () => {
  it('joins adjacent text and preserves resource links as model-visible references', async () => {
    const { ctx, agent } = fixture()
    const prompt = [
      { type: 'text' as const, text: 'first' },
      { type: 'resource_link' as const, name: 'Guide', uri: 'file:///tmp/guide.md' },
      { type: 'text' as const, text: 'last' },
    ]
    const content = await admitPrompt(ctx, agent, selection, prompt, false, new AbortController().signal)
    expect(content).toEqual([{
      type: 'text',
      text: 'first\n[resource_link name="Guide" uri="file:///tmp/guide.md"]\nlast',
    }])
    expect(admittedCommandText(prompt, content)).toBeUndefined()
  })

  it('rejects empty and unsupported prompts', async () => {
    const { ctx, agent } = fixture()
    await expect(admitPrompt(
      ctx, agent, selection, [{ type: 'text', text: ' \n ' }], false, new AbortController().signal,
    )).rejects.toThrow(new InteractivePromptError('empty prompt'))
    await expect(admitPrompt(
      ctx,
      agent,
      selection,
      [{ type: 'audio', data: 'AQ==', mimeType: 'audio/wav' }],
      false,
      new AbortController().signal,
    )).rejects.toThrow(/audio prompt content is not supported/)
    await expect(admitPrompt(
      ctx,
      agent,
      selection,
      [{ type: 'resource', resource: { uri: 'file:///tmp/a', text: 'a' } }],
      false,
      new AbortController().signal,
    )).rejects.toThrow(/embedded resource prompt content is not supported/)
  })

  it('returns command text only for text-only prompts', async () => {
    const { ctx, agent } = fixture()
    const prompt = [{ type: 'text' as const, text: '/inspect' }]
    const content = await admitPrompt(ctx, agent, selection, prompt, false, new AbortController().signal)
    expect(admittedCommandText(prompt, content)).toBe('/inspect')
    expect(admittedCommandText(prompt, [])).toBe('')
    expect(admittedCommandText(prompt, [{ type: 'reasoning', text: 'x' }] as ContentBlock[])).toBeUndefined()
  })

  it('validates image advertisement, encoding, route, and persistence failures', async () => {
    const image = { type: 'image' as const, data: 'AQ==', mimeType: 'image/png' }
    const controller = new AbortController()
    const missing = fixture()
    await expect(admitPrompt(missing.ctx, missing.agent, selection, [image], false, controller.signal))
      .rejects.toThrow(/not advertised/)
    await expect(admitPrompt(missing.ctx, missing.agent, selection, [
      { ...image, mimeType: 'image/bmp' },
    ], true, controller.signal)).rejects.toThrow(/mimeType/)
    await expect(admitPrompt(missing.ctx, missing.agent, selection, [
      { ...image, data: 'not base64' },
    ], true, controller.signal)).rejects.toThrow(/canonical base64/)
    await expect(admitPrompt(missing.ctx, missing.agent, selection, [
      { ...image, data: 'AB==' },
    ], true, controller.signal)).rejects.toThrow(/canonical base64/)
    await expect(admitPrompt(missing.ctx, missing.agent, selection, [image], true, controller.signal))
      .rejects.toThrow(/no attachment store/)

    const attachments = {
      saveImages: () => Promise.resolve([ref]),
      readImage: () => Promise.resolve({ ref, data: Uint8Array.of(1) }),
    }
    const unresolved = fixture({ attachments })
    await expect(admitPrompt(unresolved.ctx, unresolved.agent, undefined, [image], true, controller.signal))
      .rejects.toThrow(/route could not be resolved/)
    const textOnly = fixture({ attachments, route: 'text' })
    await expect(admitPrompt(textOnly.ctx, textOnly.agent, selection, [image], true, controller.signal))
      .rejects.toThrow(/does not declare image input/)
    const offline = fixture({ attachments, route: new Error('offline') })
    const offlineError = await interactiveError(
      admitPrompt(offline.ctx, offline.agent, selection, [image], true, controller.signal),
    )
    expect(offlineError.kind).toBe('internal')
    expect(offlineError.cause).toBeInstanceOf(Error)
    expect((offlineError.cause as Error).message).toBe('offline')

    const rejected = fixture({ attachments: {
      ...attachments,
      saveImages: () => Promise.reject(new AttachmentError('too large', 'IMAGE_TOO_LARGE')),
    } })
    await expect(admitPrompt(rejected.ctx, rejected.agent, selection, [image], true, controller.signal))
      .rejects.toMatchObject({ message: 'too large', kind: 'invalid' })
    const failed = fixture({ attachments: { ...attachments, saveImages: () => Promise.reject(new Error('disk')) } })
    const failedError = await interactiveError(
      admitPrompt(failed.ctx, failed.agent, selection, [image], true, controller.signal),
    )
    expect(failedError).toMatchObject({ kind: 'internal' })
    expect(failedError.message).toContain('persist')
  })

  it('persists ordered images, honors request-header fallback, and observes cancellation', async () => {
    const saved: SaveImageAttachment[][] = []
    const attachments = {
      saveImages: (inputs: readonly SaveImageAttachment[]) => {
        saved.push([...inputs])
        return Promise.resolve([ref, { ...ref, attachmentId: AttachmentId('image-2') }])
      },
      readImage: () => Promise.resolve({ ref, data: Uint8Array.of(1) }),
    }
    const { ctx, agent } = fixture({
      attachments,
      agent: {
        session: { requestHeader: () => ({ config: selection }) } as Agent['session'],
      },
    })
    const image = { type: 'image' as const, data: 'AQ==', mimeType: 'image/png' }
    const prompt = [
      { type: 'text' as const, text: 'before' },
      image,
      { type: 'resource_link' as const, name: 'Guide', uri: 'file:///guide' },
      { type: 'image' as const, data: 'Ag==', mimeType: 'image/jpeg' },
      { type: 'text' as const, text: 'after' },
    ]
    await expect(admitPrompt(ctx, agent, undefined, prompt, true, new AbortController().signal)).resolves.toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', attachment: ref },
      { type: 'text', text: '\n[resource_link name="Guide" uri="file:///guide"]\n' },
      { type: 'image', attachment: { ...ref, attachmentId: 'image-2' } },
      { type: 'text', text: 'after' },
    ])
    await expect(admitPrompt(ctx, agent, undefined, [image], true, new AbortController().signal))
      .resolves.toEqual([{ type: 'image', attachment: ref }])
    expect(saved[0]?.map(input => input.mediaType)).toEqual(['image/png', 'image/jpeg'])

    const before = new AbortController()
    before.abort(new Error('cancelled'))
    await expect(admitPrompt(ctx, agent, selection, [image], true, before.signal)).rejects.toThrow(/cancelled/)

    const after = new AbortController()
    const afterFixture = fixture({ attachments: {
      ...attachments,
      saveImages: async () => {
        after.abort(new Error('late cancellation'))
        return [ref]
      },
    } })
    await expect(admitPrompt(
      afterFixture.ctx, afterFixture.agent, selection, [image], true, after.signal,
    )).rejects.toThrow(/late cancellation/)
  })

  it('projects verified image bytes and contains missing or corrupt stores', async () => {
    const missing = fixture()
    await expect(projectImage(missing.ctx, ref)).rejects.toMatchObject({ kind: 'internal' })
    const good = fixture({ attachments: {
      saveImages: () => Promise.resolve([ref]),
      readImage: () => Promise.resolve({ ref, data: Uint8Array.of(1) }),
    } })
    await expect(projectImage(good.ctx, ref)).resolves.toEqual({
      type: 'image', data: 'AQ==', mimeType: 'image/png',
    })
    const corrupt = fixture({ attachments: {
      saveImages: () => Promise.resolve([ref]),
      readImage: () => Promise.reject(new Error('corrupt')),
    } })
    const corruptError = await interactiveError(projectImage(corrupt.ctx, ref))
    expect(corruptError.kind).toBe('internal')
    expect(corruptError.cause).toBeInstanceOf(Error)
    expect((corruptError.cause as Error).message).toBe('corrupt')
  })
})
