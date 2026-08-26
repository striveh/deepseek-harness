/** Package-owned invariant companion for managed MCP connections. @module @deepseek-ai/dsh-mcp-connections/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-mcp-connections'

/** Cordis companion plugin name. */
export const name = 'mcp-connections-invariant'
/** Services required by the companion. */
export const inject = ['invariants']

/** Cross-check each published active view against the service's committed inventory. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: Parameters<InvariantInstaller>[1]) => {
  ctx.on('mcp-connections/change', (change) => {
    const actual = ctx.mcpConnections.get(change.id)
    if (change.kind === 'removed' || change.kind === 'purged') {
      if (actual !== undefined) fail(`removed connection "${change.id}" remains in the active inventory`)
      if (change.kind === 'purged' && ctx.mcpConnections.getRemoved(change.id) !== undefined) {
        fail(`purged connection "${change.id}" remains in the removed inventory`)
      }
      return
    }
    const reported = change.view
    if (reported === undefined || actual === undefined) {
      fail(`${change.kind} change for "${change.id}" has no active committed view`)
      return
    }
    if (actual.revision !== reported.revision) {
      fail(`${change.kind} change for "${change.id}" reports revision ${String(reported.revision)} but inventory has ${String(actual.revision)}`)
    }
  })
}, { inject: ['mcpConnections'] })

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
