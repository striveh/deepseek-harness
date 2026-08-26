import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import McpConnections, {
  mcpConnectionId,
  type McpConnectionId,
  type McpConnectionsSnapshot,
  type McpConnectionView,
  type RemovedMcpConnectionView,
} from '../src/index.ts'
import * as McpConnectionsInvariant from '../src/invariant.ts'

const EMPTY_DIGEST = '0'.repeat(64)

function activeView(id: McpConnectionId, revision: number): McpConnectionView {
  return {
    id,
    revision,
    desired: {
      id,
      enabled: false,
      transport: {
        transport: 'stdio',
        command: 'node',
        args: [],
        env: {},
        cwd: '',
        toolCallTimeoutMs: 1,
        reconnect: { enabled: false, initialDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 },
      },
    },
    observed: { state: 'disabled', desiredRevision: revision, generation: 0 },
    tools: { generation: 0, digest: EMPTY_DIGEST, names: [] },
  }
}

class MutableMcpConnections extends McpConnections {
  readonly protocolVersion = 1 as const
  readonly active = new Map<McpConnectionId, McpConnectionView>()
  readonly removed = new Map<McpConnectionId, RemovedMcpConnectionView>()

  snapshot(): McpConnectionsSnapshot {
    return { revision: 0, connections: [...this.active.values()], removed: [...this.removed.values()] }
  }

  get(id: McpConnectionId): McpConnectionView | undefined { return this.active.get(id) }
  getRemoved(id: McpConnectionId): RemovedMcpConnectionView | undefined { return this.removed.get(id) }
  configure(): Promise<never> { return Promise.reject(new Error('unused')) }
  enable(): Promise<never> { return Promise.reject(new Error('unused')) }
  disable(): Promise<never> { return Promise.reject(new Error('unused')) }
  update(): Promise<never> { return Promise.reject(new Error('unused')) }
  remove(): Promise<never> { return Promise.reject(new Error('unused')) }
  restore(): Promise<never> { return Promise.reject(new Error('unused')) }
  purge(): Promise<never> { return Promise.reject(new Error('unused')) }
}

async function mountInvariant(): Promise<{ ctx: Context; service: MutableMcpConnections }> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(MutableMcpConnections)
  await ctx.plugin(McpConnectionsInvariant)
  return { ctx, service: ctx.mcpConnections as MutableMcpConnections }
}

describe('managed MCP connection invariant companion', () => {
  it('accepts committed active, removed, and purged views', async () => {
    const { ctx, service } = await mountInvariant()
    const id = mcpConnectionId('accepted')
    const view = activeView(id, 1)
    service.active.set(id, view)
    expect(() => { ctx.emit('mcp-connections/change', { kind: 'desired', id, view }) }).not.toThrow()

    service.active.delete(id)
    service.removed.set(id, { id, revision: 2, desired: view.desired, removedAtRevision: 2 })
    expect(() => { ctx.emit('mcp-connections/change', { kind: 'removed', id }) }).not.toThrow()

    service.removed.delete(id)
    expect(() => { ctx.emit('mcp-connections/change', { kind: 'purged', id }) }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('rejects removal and purge notifications that contradict either inventory', async () => {
    const { ctx, service } = await mountInvariant()
    const id = mcpConnectionId('contradiction')
    const view = activeView(id, 1)
    service.active.set(id, view)
    expect(() => { ctx.emit('mcp-connections/change', { kind: 'removed', id }) })
      .toThrow(/remains in the active inventory/)

    service.active.delete(id)
    service.removed.set(id, { id, revision: 2, desired: view.desired, removedAtRevision: 2 })
    expect(() => { ctx.emit('mcp-connections/change', { kind: 'purged', id }) })
      .toThrow(/remains in the removed inventory/)
    await ctx.fiber.dispose()
  })

  it('rejects missing and stale active views', async () => {
    const { ctx, service } = await mountInvariant()
    const id = mcpConnectionId('active')
    const view = activeView(id, 2)

    expect(() => { ctx.emit('mcp-connections/change', { kind: 'desired', id }) })
      .toThrow(/has no active committed view/)
    expect(() => { ctx.emit('mcp-connections/change', { kind: 'desired', id, view }) })
      .toThrow(/has no active committed view/)

    service.active.set(id, view)
    expect(() => { ctx.emit('mcp-connections/change', { kind: 'observed', id }) })
      .toThrow(/has no active committed view/)
    expect(() => {
      ctx.emit('mcp-connections/change', { kind: 'tools', id, view: activeView(id, 1) })
    }).toThrow(/reports revision 1 but inventory has 2/)
    await ctx.fiber.dispose()
  })
})
