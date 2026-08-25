import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { planModeDirectory, sessionModes } from '../src/modes.js'

const agent = {} as Agent

function context(state?: { active: boolean; pending?: boolean }): Context {
  return {
    get: (name: string) => name === 'planMode' && state !== undefined
      ? { get: () => state, set: () => 'committed' }
      : undefined,
  } as unknown as Context
}

describe('ACP plan-mode projection', () => {
  it('omits modes without the service and projects committed or pending state', () => {
    const absent = context()
    expect(planModeDirectory(absent)).toBeUndefined()
    expect(sessionModes(absent, agent)).toBeUndefined()

    for (const [state, currentModeId] of [
      [{ active: false }, 'default'],
      [{ active: true }, 'plan'],
      [{ active: false, pending: true }, 'plan'],
      [{ active: true, pending: false }, 'default'],
    ] as const) {
      const ctx = context(state)
      expect(planModeDirectory(ctx)).toBeDefined()
      expect(sessionModes(ctx, agent)).toEqual({
        availableModes: [
          {
            id: 'default', name: 'Default',
            description: "Work normally with the session's configured tools and permissions.",
          },
          {
            id: 'plan', name: 'Plan',
            description: 'Develop and review a plan before carrying it out.',
          },
        ],
        currentModeId,
      })
    }
  })
})
