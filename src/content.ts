/** Text-only ACP prompt admission for the first interactive editor release. */

import type { ContentBlock as AcpContentBlock } from '@agentclientprotocol/sdk'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Rejection raised when an ACP prompt cannot enter the first-phase text route. */
export class InteractivePromptError extends Error {
  override readonly name = 'InteractivePromptError'
}

/**
 * Admit ACP text blocks without silently dropping richer content.
 * @param prompt - untrusted protocol prompt blocks.
 * @returns one model-facing text block.
 * @throws {InteractivePromptError} when a block is unsupported or the combined text is empty.
 */
export function admitTextPrompt(prompt: readonly AcpContentBlock[]): ContentBlock[] {
  let text = ''
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new InteractivePromptError(`unsupported prompt content: ${block.type}`)
    }
    text += block.text
  }
  if (text.trim().length === 0) throw new InteractivePromptError('empty prompt')
  return [{ type: 'text', text }]
}

/**
 * Return the exact admitted text for slash-command dispatch.
 * @param content - output of {@link admitTextPrompt}.
 * @returns the single text block's contents.
 */
export function admittedText(content: readonly ContentBlock[]): string {
  const block = content[0]
  if (block?.type !== 'text') throw new Error('interactive ACP prompt admission did not produce text')
  return block.text
}
