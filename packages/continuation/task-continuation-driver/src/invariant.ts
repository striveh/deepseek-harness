/**
 * Package-owned invariant companion for the durable task-continuation driver.
 * @module @deepseek-ai/dsh-task-continuation-driver/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-task-continuation-driver'

/** Cordis companion plugin name. */
export const name = 'task-continuation-driver-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: durable recovery and single-use admission require a filesystem restart round trip. */
const install: InvariantInstaller = () => {}

/**
 * Register the durable continuation driver's invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
