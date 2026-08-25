import { describe, expect, it } from 'vitest'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import { turnEndToStopReason } from '../src/codec.js'

describe('interactive ACP stop-reason codec', () => {
  it.each<[TurnEndReason, string]>([
    [{ kind: 'max-tokens' }, 'max_tokens'],
    [{ kind: 'interrupted' }, 'cancelled'],
    [{ kind: 'completed' }, 'end_turn'],
    [{ kind: 'aborted', reason: { kind: 'user' } }, 'end_turn'],
    [{ kind: 'blocked' }, 'end_turn'],
    [{ kind: 'error', error: { message: 'failed', code: 'UNKNOWN' } }, 'end_turn'],
    [{ kind: 'extension' } as never, 'end_turn'],
  ])('maps $0.kind to $1', (reason, expected) => {
    expect(turnEndToStopReason(reason)).toBe(expected)
  })
})
