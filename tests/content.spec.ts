import { describe, expect, it } from 'vitest'
import { admitTextPrompt, admittedText, InteractivePromptError } from '../src/content.js'

describe('interactive ACP prompt admission', () => {
  it('joins text blocks without changing their contents', () => {
    expect(admitTextPrompt([
      { type: 'text', text: 'first' },
      { type: 'text', text: '\nsecond' },
    ])).toEqual([{ type: 'text', text: 'first\nsecond' }])
  })

  it('rejects empty and non-text prompts', () => {
    expect(() => admitTextPrompt([{ type: 'text', text: ' \n ' }]))
      .toThrow(new InteractivePromptError('empty prompt'))
    expect(() => admitTextPrompt([{ type: 'audio', data: 'AQ==', mimeType: 'audio/wav' }]))
      .toThrow(/unsupported prompt content: audio/)
  })

  it('returns the admitted text and rejects an invalid same-process value', () => {
    expect(admittedText([{ type: 'text', text: 'exact' }])).toBe('exact')
    expect(() => admittedText([])).toThrow(/did not produce text/)
  })
})
