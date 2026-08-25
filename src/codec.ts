/** Pure ACP response mappings shared by the interactive bridge. */

import type { StopReason } from '@agentclientprotocol/sdk'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'

/**
 * Map a durable harness turn ending to ACP's prompt stop vocabulary.
 * @param reason - recorded reason for ending the correlated turn.
 * @returns the closest ACP prompt stop reason.
 */
export function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case 'max-tokens':
      return 'max_tokens'
    case 'interrupted':
      return 'cancelled'
    case 'completed':
    case 'aborted':
    case 'blocked':
    case 'error':
    default:
      return 'end_turn'
  }
}
