/** ACP session-mode projection over the optional dsh plan-mode service. */

import type { SessionModeState } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** ACP id for ordinary execution mode. */
export const DEFAULT_MODE_ID = 'default'
/** ACP id for the constrained planning mode. */
export const PLAN_MODE_ID = 'plan'

/** Read/write face of the optional plan-mode controller. */
export interface PlanModeDirectory {
  /** Read committed state plus a next-step selection. */
  get(agent: Agent): { active: boolean; pending?: boolean }
  /** Select the state applied at the next safe step boundary. */
  set(agent: Agent, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop'
}

/**
 * Return the optional plan-mode controller.
 * @param ctx - composition that may provide plan mode.
 * @returns the controller, or undefined when the capability is absent.
 */
export function planModeDirectory(ctx: Context): PlanModeDirectory | undefined {
  return ctx.get('planMode')
}

/**
 * Build initial ACP mode state, or omit modes when plan mode is not composed.
 * @param ctx - composition that may provide plan mode.
 * @param agent - exact session whose mode is projected.
 * @returns ACP mode state, or undefined when the capability is absent.
 */
export function sessionModes(ctx: Context, agent: Agent): SessionModeState | undefined {
  const planMode = planModeDirectory(ctx)
  if (planMode === undefined) return undefined
  const state = planMode.get(agent)
  return {
    availableModes: [
      {
        id: DEFAULT_MODE_ID,
        name: 'Default',
        description: 'Work normally with the session\'s configured tools and permissions.',
      },
      {
        id: PLAN_MODE_ID,
        name: 'Plan',
        description: 'Develop and review a plan before carrying it out.',
      },
    ],
    currentModeId: (state.pending ?? state.active) ? PLAN_MODE_ID : DEFAULT_MODE_ID,
  }
}
