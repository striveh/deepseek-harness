/**
 * Package-owned invariant companion for the local Profile transaction provider.
 * @module @deepseek-ai/dsh-profile-transactions-local/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-profile-transactions-local'

/** Cordis companion plugin name. */
export const name = 'profile-transactions-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: generation completeness and durability require
 * filesystem restart round trips under the provider's writer protocol.
 */
const install: InvariantInstaller = () => {}

/**
 * Register the local Profile transaction provider's invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
