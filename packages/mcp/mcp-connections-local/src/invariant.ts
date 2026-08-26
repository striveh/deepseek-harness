/** Package-owned invariant companion for the local managed MCP provider. @module @deepseek-ai/dsh-mcp-connections-local/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-connections-local'

/** Cordis companion plugin name. */
export const name = 'mcp-connections-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: desired/view relations are checked by
 * the Service Definition companion, while tool ownership belongs to mcp-client.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
