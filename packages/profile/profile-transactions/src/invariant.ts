/** Package-owned invariant companion for the Profile transaction definition. @module @deepseek-ai/dsh-profile-transactions/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-profile-transactions'

/** Cordis companion plugin name. */
export const name = 'profile-transactions-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: this abstract definition owns types and operation semantics but no independently observable state. */
const install: InvariantInstaller = () => {}

/**
 * Register the Profile transaction definition's invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
