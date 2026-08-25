/** ACP prompt admission and durable image projection for the interactive transport. */

import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import { isImageAdmissionError } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Protocol-safe content admission failure. */
export class InteractivePromptError extends Error {
  override readonly name = 'InteractivePromptError'
  /** Whether the handler reports invalid params or an internal failure. */
  readonly kind: 'invalid' | 'internal'

  /**
   * @param message - safe detail containing no submitted binary data.
   * @param kind - ACP request failure category.
   * @param options - optional causal chain.
   */
  constructor(message: string, kind: 'invalid' | 'internal' = 'invalid', options?: ErrorOptions) {
    super(message, options)
    this.kind = kind
  }
}

function imageMediaType(value: string): ImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES.includes(value as ImageMediaType) ? value as ImageMediaType : undefined
}

function decodeImage(block: Extract<AcpContentBlock, { type: 'image' }>): SaveImageAttachment {
  const mediaType = imageMediaType(block.mimeType)
  if (mediaType === undefined) {
    throw new InteractivePromptError('image mimeType must be image/png, image/jpeg, image/webp, or image/gif')
  }
  if (!CANONICAL_BASE64.test(block.data)) {
    throw new InteractivePromptError('image data must be canonical base64')
  }
  const data = Buffer.from(block.data, 'base64')
  if (data.toString('base64') !== block.data) {
    throw new InteractivePromptError('image data must be canonical base64')
  }
  return { data, mediaType }
}

async function assertImageRoute(
  ctx: Context,
  agent: Agent,
  selection: ModelSelection | undefined,
  signal: AbortSignal,
): Promise<void> {
  const routed = selection ?? agent.session.requestHeader()?.config ?? agent.options
  if (routed.provider === undefined || routed.model === undefined) {
    throw new InteractivePromptError('the current model route could not be resolved for image input')
  }
  try {
    const info = await ctx.llm.resolveModelInfo(routed.provider, routed.model, signal)
    if (info.inputModalities?.includes('image') !== true) {
      throw new InteractivePromptError(`model "${routed.model}" does not declare image input`)
    }
  } catch (error: unknown) {
    if (error instanceof InteractivePromptError) throw error
    throw new InteractivePromptError(
      'the current model route could not be verified for image input',
      'internal',
      { cause: error },
    )
  }
}

function resourceLinkText(block: Extract<AcpContentBlock, { type: 'resource_link' }>): string {
  return `\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`
}

/**
 * Admit text, baseline resource links, and inline raster images into one durable user message.
 * @param ctx - bridge context carrying the optional attachment store and LLM registry.
 * @param agent - exact destination agent whose selected route controls image admission.
 * @param selection - route selected for the next assembled step.
 * @param prompt - untrusted ACP blocks in wire order.
 * @param imageEnabled - whether this connection advertised image prompts.
 * @param signal - cancellation for route checks and attachment work.
 * @returns ordered core content containing references instead of inline image bytes.
 */
export async function admitPrompt(
  ctx: Context,
  agent: Agent,
  selection: ModelSelection | undefined,
  prompt: readonly AcpContentBlock[],
  imageEnabled: boolean,
  signal: AbortSignal,
): Promise<ContentBlock[]> {
  const images: SaveImageAttachment[] = []
  for (const block of prompt) {
    switch (block.type) {
      case 'text':
      case 'resource_link':
        break
      case 'image':
        if (!imageEnabled) throw new InteractivePromptError('inline image prompts were not advertised by this connection')
        images.push(decodeImage(block))
        break
      case 'audio':
        throw new InteractivePromptError('audio prompt content is not supported')
      case 'resource':
        throw new InteractivePromptError('embedded resource prompt content is not supported')
      /* v8 ignore next 2 -- ACP ContentBlock is a closed generated union. */
      default:
        throw new InteractivePromptError('unsupported ACP prompt content')
    }
  }

  let refs: readonly ImageAttachmentRef[] = []
  if (images.length > 0) {
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new InteractivePromptError('no attachment store is mounted')
    await assertImageRoute(ctx, agent, selection, signal)
    signal.throwIfAborted()
    try {
      refs = await attachments.saveImages(images)
    } catch (error: unknown) {
      if (isImageAdmissionError(error)) {
        throw new InteractivePromptError(error.message, 'invalid', { cause: error })
      }
      throw new InteractivePromptError('unable to persist the prompt image batch', 'internal', { cause: error })
    }
    signal.throwIfAborted()
  }

  const content: ContentBlock[] = []
  let pendingText = ''
  let imageIndex = 0
  const flushText = (): void => {
    if (pendingText.length === 0) return
    content.push({ type: 'text', text: pendingText })
    pendingText = ''
  }
  for (const block of prompt) {
    switch (block.type) {
      case 'text':
        pendingText += block.text
        break
      case 'resource_link':
        pendingText += resourceLinkText(block)
        break
      case 'image':
        flushText()
        content.push({ type: 'image', attachment: refs[imageIndex++] as ImageAttachmentRef })
        break
      /* v8 ignore start -- rejected by the validation pass before reconstruction. */
      case 'audio':
      case 'resource':
        /* Rejected by the validation pass before reconstruction. */
        break
      default:
        break
      /* v8 ignore stop */
    }
  }
  flushText()
  if (!content.some(block => block.type === 'image' || (block.type === 'text' && block.text.trim().length > 0))) {
    throw new InteractivePromptError('empty prompt')
  }
  return content
}

/**
 * Return command text only when the original ACP prompt contains text blocks exclusively.
 * @param prompt - original wire blocks.
 * @param content - admitted model content.
 * @returns exact concatenated text, or undefined for a rich prompt.
 */
export function admittedCommandText(
  prompt: readonly AcpContentBlock[],
  content: readonly ContentBlock[],
): string | undefined {
  if (prompt.some(block => block.type !== 'text')) return undefined
  return content.every(block => block.type === 'text')
    ? content.map(block => block.text).join('')
    : undefined
}

/**
 * Read and verify a durable image before projecting it to ACP.
 * @param ctx - context carrying the authoritative attachment store.
 * @param ref - durable image reference from session history.
 * @returns inline ACP image content.
 */
export async function projectImage(ctx: Context, ref: ImageAttachmentRef): Promise<AcpContentBlock> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    throw new InteractivePromptError('cannot project image: no attachment store is mounted', 'internal')
  }
  try {
    const stored = await attachments.readImage(ref)
    return {
      type: 'image',
      data: Buffer.from(stored.data).toString('base64'),
      mimeType: stored.ref.mediaType,
    }
  } catch (error: unknown) {
    throw new InteractivePromptError('cannot project image: the attachment is unavailable or corrupt', 'internal', {
      cause: error,
    })
  }
}
