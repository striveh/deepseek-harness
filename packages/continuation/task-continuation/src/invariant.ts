/** Package-owned invariant companion for task continuation. @module @deepseek-ai/dsh-task-continuation/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-task-continuation'

/** Cordis companion plugin name. */
export const name = 'task-continuation-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the definition owns validation and registry semantics while a provider owns durable state. */
const install: InvariantInstaller = () => {}

/**
 * Register the task-continuation definition's invariant companion.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
