/** Package-owned invariant companion for `dsh-acp-interactive`. @module dsh-acp-interactive/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-acp-interactive'

/** Cordis companion plugin name. */
export const name = 'acp-interactive-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: protocol projections own no independent mutable domain or durable event. */
const install: InvariantInstaller = () => {}

/**
 * Register the interactive ACP invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
