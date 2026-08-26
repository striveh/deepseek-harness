import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, appendFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service, symbols, type Fiber } from '@deepseek-ai/cordis'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import {
  McpConnectionConflictError,
  McpConnectionIdempotencyError,
  McpConnections,
  mcpConnectionId,
  mcpConnectionMutationId,
  parseMcpConnectionDesired,
  parseMcpTransportDescriptor,
} from '@deepseek-ai/dsh-mcp-connections'
import * as DirectMcpClient from '@deepseek-ai/dsh-mcp-client'

import LocalMcpConnections, { resolveSpec } from '../src/index.ts'
import {
  DEFAULT_MCP_STATE_LOCK_WAIT_MS,
  MAX_MCP_STATE_LOCK_WAIT_MS,
} from '../src/coordinator.ts'

const reconnect = {
  enabled: true,
  initialDelayMs: 10,
  maxDelayMs: 100,
  maxAttempts: 3,
} as const

interface MountedProvider {
  ctx: Context
  fiber: Fiber
}

const roots: string[] = []
const contexts: Context[] = []
const servers: Server[] = []
const fixtureServerPath = fileURLToPath(new URL('./fixture-server.ts', import.meta.url))

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolveClose) => {
    server.close(() => { resolveClose() })
  })))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempStatePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-connections-'))
  roots.push(root)
  return join(root, 'connections.json')
}

async function mount(path: string): Promise<MountedProvider> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = ctx.plugin(LocalMcpConnections, { path })
  await fiber
  return { ctx, fiber }
}

async function mountForeignTool(ctx: Context, name: string): Promise<Fiber> {
  const fiber = ctx.plugin({
    name: 'foreign-mcp-tool',
    inject: ['tools'],
    apply(inner: Context) {
      inner.tools.register(defineContentToolFixture({
        name,
        description: 'Unmanaged tool fixture.',
        parameters: {},
        async execute() { return [{ type: 'text', text: 'foreign' }] },
      }))
    },
  })
  await fiber
  return fiber
}

async function mountEmptyServerReservation(ctx: Context, id: string, statePath: string): Promise<Fiber> {
  const fiber = ctx.plugin(DirectMcpClient, {
    transport: 'stdio',
    serverName: id,
    command: join(statePath, '..', `missing-${id}`),
    args: [],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 1_000,
    failOnStartupError: false,
    reconnect: { enabled: false },
  })
  await fiber
  return fiber
}

async function settleToolRefresh(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

function isMcpConnectionsV1(value: unknown): value is McpConnections {
  return value instanceof McpConnections && value.protocolVersion === 1
}

function originalLocalProvider(ctx: Context): LocalMcpConnections {
  const original = (ctx.mcpConnections as LocalMcpConnections & {
    [symbols.original]?: LocalMcpConnections
  })[symbols.original]
  if (original === undefined) throw new Error('missing original local MCP provider')
  return original
}

function stdioDesired(id: string, toolName: string, enabled = false, slowClose = false) {
  return parseMcpConnectionDesired({
    id,
    enabled,
    transport: {
      transport: 'stdio',
      command: process.execPath,
      args: [fixtureServerPath, toolName, ...slowClose ? ['slow-close'] : []],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 10_000,
      reconnect,
    },
  })
}

function stdioDesiredWithPrototypeEnv(id: string, value: string) {
  const env = JSON.parse(`{"__proto__":${JSON.stringify(value)}}`) as Record<string, string>
  return parseMcpConnectionDesired({
    id,
    enabled: false,
    transport: {
      transport: 'stdio',
      command: process.execPath,
      args: [fixtureServerPath, 'prototype-env'],
      env,
      cwd: '',
      toolCallTimeoutMs: 10_000,
      reconnect,
    },
  })
}

async function startHttpFixture(): Promise<string> {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const server = new McpServer(
      { name: 'managed-http', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    server.registerTool('ping', { description: 'Replies pong.', inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }))
    server.registerTool('alpha', { description: 'Replies first.', inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'first' }],
    }))
    const transport = new StreamableHTTPServerTransport({})
    res.on('close', () => { void transport.close(); void server.close() })
    await server.connect(transport as Transport)
    await transport.handleRequest(req, res)
  }
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => { res.writeHead(500).end(String(error)) })
  })
  servers.push(server)
  const listening: PromiseWithResolvers<void> = Promise.withResolvers()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP fixture did not bind a TCP port')
  return `http://127.0.0.1:${String(address.port)}/mcp`
}

describe('service protocol identity', () => {
  it('lets a consumer reject a same-name fake and an incompatible revision', async () => {
    const { ctx } = await mount(await tempStatePath())
    const protocolVersion: 1 = ctx.mcpConnections.protocolVersion
    const sameNameFake = { name: ctx.mcpConnections.name, protocolVersion }
    const incompatibleRevision: unknown = Object.setPrototypeOf(
      { name: ctx.mcpConnections.name, protocolVersion: 2 },
      McpConnections.prototype,
    )

    expect(isMcpConnectionsV1(ctx.mcpConnections)).toBe(true)
    expect(isMcpConnectionsV1(sameNameFake)).toBe(false)
    expect(incompatibleRevision).toBeInstanceOf(McpConnections)
    expect(isMcpConnectionsV1(incompatibleRevision)).toBe(false)
  })
})

describe('dynamic lifecycle over the real mcp-client plugin', () => {
  it('rejects configure before commit when an unmanaged Fiber occupies the server namespace', async () => {
    const path = await tempStatePath()
    const { ctx, fiber } = await mount(path)
    const foreignName = 'mcp__collision__z-last'
    const firstForeignName = 'mcp__collision__a-first'
    await mountForeignTool(ctx, foreignName)
    await mountForeignTool(ctx, firstForeignName)
    const foreignDefinition = ctx.tools.get(foreignName)
    expect(foreignDefinition).toBeDefined()
    const id = mcpConnectionId('collision')

    await expect(ctx.mcpConnections.configure({
      desired: stdioDesired(id, 'managed', true),
      mutationId: mcpConnectionMutationId('collision-configure'),
      expectedRevision: 0,
    })).rejects.toThrow(/namespace.*mcp__collision__.*a-first.*z-last/)

    expect(ctx.mcpConnections.snapshot()).toMatchObject({ revision: 0, connections: [], removed: [] })
    expect(ctx.tools.get(foreignName)).toBe(foreignDefinition)
    expect(ctx.tools.get(firstForeignName)).toBeDefined()

    await fiber.dispose()
    expect(ctx.tools.get(foreignName)).toBe(foreignDefinition)
    expect(ctx.tools.get(firstForeignName)).toBeDefined()
    const resumed = await mount(path)
    expect(resumed.ctx.mcpConnections.snapshot()).toMatchObject({ revision: 0, connections: [], removed: [] })
  })

  it('rejects enable and enabled restore before commit when an unmanaged Fiber took the namespace', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)

    const disabledId = mcpConnectionId('enable-collision')
    const disabled = await ctx.mcpConnections.configure({
      desired: stdioDesired(disabledId, 'managed'),
      mutationId: mcpConnectionMutationId('enable-collision-configure'),
      expectedRevision: 0,
    })
    const disabledForeign = `mcp__${disabledId}__foreign`
    await mountForeignTool(ctx, disabledForeign)
    await expect(ctx.mcpConnections.enable({
      id: disabledId,
      mutationId: mcpConnectionMutationId('enable-collision-enable'),
      expectedRevision: disabled.revision,
    })).rejects.toThrow(/cannot activate.*namespace.*enable-collision/)
    expect(ctx.mcpConnections.get(disabledId)).toMatchObject({
      revision: disabled.revision,
      desired: { enabled: false },
    })

    const removedId = mcpConnectionId('restore-collision')
    const enabled = await ctx.mcpConnections.configure({
      desired: stdioDesired(removedId, 'managed', true),
      mutationId: mcpConnectionMutationId('restore-collision-configure'),
      expectedRevision: 0,
    })
    const removed = await ctx.mcpConnections.remove({
      id: removedId,
      mutationId: mcpConnectionMutationId('restore-collision-remove'),
      expectedRevision: enabled.revision,
    })
    const removedForeign = `mcp__${removedId}__foreign`
    await mountForeignTool(ctx, removedForeign)
    const snapshotRevision = ctx.mcpConnections.snapshot().revision
    await expect(ctx.mcpConnections.restore({
      id: removedId,
      mutationId: mcpConnectionMutationId('restore-collision-restore'),
      expectedRevision: removed.revision,
    })).rejects.toThrow(/cannot activate.*namespace.*restore-collision/)
    expect(ctx.mcpConnections.snapshot().revision).toBe(snapshotRevision)
    expect(ctx.mcpConnections.get(removedId)).toBeUndefined()
    expect(ctx.mcpConnections.getRemoved(removedId)?.revision).toBe(removed.revision)
    expect(ctx.tools.get(disabledForeign)).toBeDefined()
    expect(ctx.tools.get(removedForeign)).toBeDefined()
  })

  it('rejects lifecycle activation before commit when a direct empty mcp-client reserved the server name', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)

    const configureId = mcpConnectionId('reserved-configure')
    await mountEmptyServerReservation(ctx, configureId, path)
    expect(ctx.tools.schemas().some(schema => schema.name.startsWith(`mcp__${configureId}__`))).toBe(false)
    await expect(ctx.mcpConnections.configure({
      desired: stdioDesired(configureId, 'managed'),
      mutationId: mcpConnectionMutationId('reserved-configure-mutation'),
      expectedRevision: 0,
    })).rejects.toThrow(/serverName.*already in use/)
    expect(ctx.mcpConnections.snapshot().revision).toBe(0)

    const enableId = mcpConnectionId('reserved-enable')
    const disabled = await ctx.mcpConnections.configure({
      desired: stdioDesired(enableId, 'managed'),
      mutationId: mcpConnectionMutationId('reserved-enable-configure'),
      expectedRevision: 0,
    })
    await mountEmptyServerReservation(ctx, enableId, path)
    await expect(ctx.mcpConnections.enable({
      id: enableId,
      mutationId: mcpConnectionMutationId('reserved-enable-mutation'),
      expectedRevision: disabled.revision,
    })).rejects.toThrow(/serverName.*already in use/)
    expect(ctx.mcpConnections.get(enableId)).toMatchObject({
      revision: disabled.revision,
      desired: { enabled: false },
    })

    const restoreId = mcpConnectionId('reserved-restore')
    const enabled = await ctx.mcpConnections.configure({
      desired: stdioDesired(restoreId, 'managed', true),
      mutationId: mcpConnectionMutationId('reserved-restore-configure'),
      expectedRevision: 0,
    })
    const removed = await ctx.mcpConnections.remove({
      id: restoreId,
      mutationId: mcpConnectionMutationId('reserved-restore-remove'),
      expectedRevision: enabled.revision,
    })
    await mountEmptyServerReservation(ctx, restoreId, path)
    const beforeRestore = ctx.mcpConnections.snapshot().revision
    await expect(ctx.mcpConnections.restore({
      id: restoreId,
      mutationId: mcpConnectionMutationId('reserved-restore-mutation'),
      expectedRevision: removed.revision,
    })).rejects.toThrow(/serverName.*already in use/)
    expect(ctx.mcpConnections.snapshot().revision).toBe(beforeRestore)
    expect(ctx.mcpConnections.getRemoved(restoreId)?.revision).toBe(removed.revision)
  })

  it('reports only the live managed Fiber tools and leaves foreign tools intact after disable and remove', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)
    const id = mcpConnectionId('provenance')
    const configured = await ctx.mcpConnections.configure({
      desired: stdioDesired(id, 'managed', true),
      mutationId: mcpConnectionMutationId('provenance-configure'),
      expectedRevision: 0,
    })
    const foreignSibling = 'mcp__provenance__foreign'
    await mountForeignTool(ctx, foreignSibling)
    const foreignSiblingDefinition = ctx.tools.get(foreignSibling)
    expect(foreignSiblingDefinition).toBeDefined()
    await settleToolRefresh()

    expect(ctx.mcpConnections.get(id)?.tools.names).toEqual(['mcp__provenance__managed'])

    const disabled = await ctx.mcpConnections.disable({
      id,
      mutationId: mcpConnectionMutationId('provenance-disable'),
      expectedRevision: configured.revision,
    })
    const foreignReplacement = 'mcp__provenance__managed'
    await mountForeignTool(ctx, foreignReplacement)
    const foreignReplacementDefinition = ctx.tools.get(foreignReplacement)
    expect(foreignReplacementDefinition).toBeDefined()
    await settleToolRefresh()

    expect(ctx.mcpConnections.get(id)?.tools.names).toEqual([])
    expect(ctx.tools.get(foreignSibling)).toBe(foreignSiblingDefinition)
    expect(ctx.tools.get(foreignReplacement)).toBe(foreignReplacementDefinition)

    const removed = await ctx.mcpConnections.remove({
      id,
      mutationId: mcpConnectionMutationId('provenance-remove'),
      expectedRevision: disabled.revision,
    })
    expect(ctx.mcpConnections.get(id)).toBeUndefined()
    expect(ctx.tools.get(foreignSibling)).toBe(foreignSiblingDefinition)
    expect(ctx.tools.get(foreignReplacement)).toBe(foreignReplacementDefinition)

    await ctx.mcpConnections.restore({
      id,
      mutationId: mcpConnectionMutationId('provenance-restore'),
      expectedRevision: removed.revision,
    })
    expect(ctx.mcpConnections.get(id)?.tools.names).toEqual([])
    expect(ctx.tools.get(foreignSibling)).toBe(foreignSiblingDefinition)
    expect(ctx.tools.get(foreignReplacement)).toBe(foreignReplacementDefinition)
  })

  it('configures, enables, updates, removes, restores, and cold-resumes a stdio connection', async () => {
    const path = await tempStatePath()
    const { ctx, fiber } = await mount(path)
    const id = mcpConnectionId('fixture')

    const configured = await ctx.mcpConnections.configure({
      desired: stdioDesired(id, 'v1', true),
      mutationId: mcpConnectionMutationId('configure-1'),
      expectedRevision: 0,
    })
    expect(configured.revision).toBe(1)
    expect(ctx.tools.get('mcp__fixture__v1')).toBeDefined()
    expect(ctx.mcpConnections.get(id)).toMatchObject({
      desired: { enabled: true },
      revision: configured.revision,
      observed: { state: 'ready', desiredRevision: configured.revision },
      tools: { names: ['mcp__fixture__v1'] },
    })

    const updated = await ctx.mcpConnections.update({
      id,
      mutationId: mcpConnectionMutationId('update-1'),
      expectedRevision: configured.revision,
      transport: stdioDesired(id, 'v2').transport,
    })
    expect(ctx.tools.get('mcp__fixture__v1')).toBeUndefined()
    expect(ctx.tools.get('mcp__fixture__v2')).toBeDefined()
    expect(ctx.mcpConnections.get(id)?.tools.generation).toBeGreaterThan(1)

    const disabled = await ctx.mcpConnections.disable({
      id,
      mutationId: mcpConnectionMutationId('disable-1'),
      expectedRevision: updated.revision,
    })
    expect(ctx.tools.get('mcp__fixture__v2')).toBeUndefined()
    expect(ctx.mcpConnections.get(id)).toMatchObject({
      observed: { state: 'disabled', desiredRevision: disabled.revision },
      tools: { names: [] },
    })

    const reenabled = await ctx.mcpConnections.enable({
      id,
      mutationId: mcpConnectionMutationId('enable-1'),
      expectedRevision: disabled.revision,
    })
    expect(ctx.tools.get('mcp__fixture__v2')).toBeDefined()

    const removed = await ctx.mcpConnections.remove({
      id,
      mutationId: mcpConnectionMutationId('remove-1'),
      expectedRevision: reenabled.revision,
    })
    expect(ctx.tools.get('mcp__fixture__v2')).toBeUndefined()
    expect(ctx.mcpConnections.get(id)).toBeUndefined()
    expect(ctx.mcpConnections.getRemoved(id)).toMatchObject({ revision: removed.revision, desired: { enabled: true } })

    const restored = await ctx.mcpConnections.restore({
      id,
      mutationId: mcpConnectionMutationId('restore-1'),
      expectedRevision: removed.revision,
    })
    expect(ctx.tools.get('mcp__fixture__v2')).toBeDefined()
    expect(ctx.mcpConnections.get(id)?.revision).toBe(restored.revision)

    await fiber.dispose()
    expect(ctx.tools.get('mcp__fixture__v2')).toBeUndefined()

    const resumed = await mount(path)
    expect(resumed.ctx.mcpConnections.get(id)).toMatchObject({ observed: { state: 'ready' } })
    expect(resumed.ctx.tools.get('mcp__fixture__v2')).toBeDefined()
  })

  it('does not resolve remove until the mcp-client generation reaches quiescence', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)
    const id = mcpConnectionId('slow')
    const configured = await ctx.mcpConnections.configure({
      desired: stdioDesired(id, 'tool', true, true),
      mutationId: mcpConnectionMutationId('slow-configure'),
      expectedRevision: 0,
    })
    expect(ctx.tools.get('mcp__slow__tool')).toBeDefined()

    let settled = false
    const removal = ctx.mcpConnections.remove({
      id,
      mutationId: mcpConnectionMutationId('slow-remove'),
      expectedRevision: configured.revision,
    }).then((receipt) => {
      settled = true
      return receipt
    })
    await vi.waitFor(() => { expect(ctx.mcpConnections.get(id)).toBeUndefined() })
    expect(settled).toBe(false)
    await removal
    expect(ctx.tools.get('mcp__slow__tool')).toBeUndefined()
  })

  it('purges only an exact removed tombstone and replays the same request idempotently', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)
    const id = mcpConnectionId('temporary')
    const configured = await ctx.mcpConnections.configure({
      desired: stdioDesired(id, 'tool', false),
      mutationId: mcpConnectionMutationId('temporary-configure'),
      expectedRevision: 0,
    })
    await expect(ctx.mcpConnections.purge({
      id,
      mutationId: mcpConnectionMutationId('purge-active'),
      expectedRevision: configured.revision,
    })).rejects.toThrow(/removed inventory/)

    const removed = await ctx.mcpConnections.remove({
      id,
      mutationId: mcpConnectionMutationId('temporary-remove'),
      expectedRevision: configured.revision,
    })
    const request = {
      id,
      mutationId: mcpConnectionMutationId('temporary-purge'),
      expectedRevision: removed.revision,
    }
    const purged = await ctx.mcpConnections.purge(request)
    expect(purged).toMatchObject({
      operation: 'purge',
      previousRevision: removed.revision,
      revision: removed.revision + 1,
      changed: true,
      desiredDigest: null,
    })
    expect(ctx.mcpConnections.get(id)).toBeUndefined()
    expect(ctx.mcpConnections.getRemoved(id)).toBeUndefined()
    await expect(ctx.mcpConnections.purge(request)).resolves.toEqual(purged)
    await expect(ctx.mcpConnections.restore({
      id,
      mutationId: mcpConnectionMutationId('restore-purged'),
      expectedRevision: purged.revision,
    })).rejects.toThrow(/removed inventory/)
  })

  it('mounts Streamable HTTP descriptors and reports startup failures without losing desired state', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)
    const httpUrl = await startHttpFixture()
    const httpId = mcpConnectionId('web')
    await ctx.mcpConnections.configure({
      desired: parseMcpConnectionDesired({
        id: httpId,
        enabled: true,
        transport: {
          transport: 'streamable-http',
          url: httpUrl,
          headers: {},
          redirect: 'error',
          toolCallTimeoutMs: 10_000,
          reconnect,
        },
      }),
      mutationId: mcpConnectionMutationId('http-configure'),
      expectedRevision: 0,
    })
    expect(ctx.tools.get('mcp__web__ping')).toBeDefined()
    expect(ctx.mcpConnections.get(httpId)?.tools.names).toEqual(['mcp__web__alpha', 'mcp__web__ping'])

    const failedId = mcpConnectionId('failed')
    await ctx.mcpConnections.configure({
      desired: parseMcpConnectionDesired({
        id: failedId,
        enabled: true,
        transport: {
          transport: 'stdio',
          command: join(path, '..', 'missing-mcp-executable'),
          args: [],
          env: {},
          cwd: '',
          toolCallTimeoutMs: 10_000,
          reconnect,
        },
      }),
      mutationId: mcpConnectionMutationId('failed-configure'),
      expectedRevision: 0,
    })
    const failed = ctx.mcpConnections.get(failedId)
    expect(failed?.desired.enabled).toBe(true)
    expect(failed?.observed.state).toBe('error')
    expect(failed?.observed.message).toContain('initial connection')
    expect(failed?.tools.names).toEqual([])
  })
})

describe('durable authority and recovery', () => {
  it('rejects duplicate active and removed ids and missing active mutations', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)
    const id = mcpConnectionId('conflict')
    const configured = await ctx.mcpConnections.configure({
      desired: stdioDesired(id, 'one'),
      mutationId: mcpConnectionMutationId('conflict-configure'),
      expectedRevision: 0,
    })

    await expect(ctx.mcpConnections.configure({
      desired: stdioDesired(id, 'two'),
      mutationId: mcpConnectionMutationId('conflict-active'),
      expectedRevision: 0,
    })).rejects.toBeInstanceOf(McpConnectionConflictError)

    await ctx.mcpConnections.remove({
      id,
      mutationId: mcpConnectionMutationId('conflict-remove'),
      expectedRevision: configured.revision,
    })
    expect(ctx.mcpConnections.snapshot().removed).toHaveLength(1)
    await expect(ctx.mcpConnections.configure({
      desired: stdioDesired(id, 'three'),
      mutationId: mcpConnectionMutationId('conflict-removed'),
      expectedRevision: 0,
    })).rejects.toBeInstanceOf(McpConnectionConflictError)
    await expect(ctx.mcpConnections.enable({
      id: mcpConnectionId('missing'),
      mutationId: mcpConnectionMutationId('missing-enable'),
      expectedRevision: 1,
    })).rejects.toThrow(/active inventory/)
  })

  it('records no-op desired mutations without restarting the managed Fiber', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)
    const id = mcpConnectionId('no-op')
    const desired = stdioDesired(id, 'stable')
    const configured = await ctx.mcpConnections.configure({
      desired,
      mutationId: mcpConnectionMutationId('no-op-configure'),
      expectedRevision: 0,
    })
    const updated = await ctx.mcpConnections.update({
      id,
      transport: desired.transport,
      mutationId: mcpConnectionMutationId('no-op-update'),
      expectedRevision: configured.revision,
    })

    expect(updated).toMatchObject({ changed: false, revision: configured.revision })
    expect(updated.snapshotRevision).toBeGreaterThan(configured.snapshotRevision)
  })

  it('detaches configure and update inputs before queueing and retains no caller aliases after commit', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)
    const id = mcpConnectionId('detached')
    const desired = {
      id,
      enabled: false,
      transport: {
        transport: 'stdio' as const,
        command: process.execPath,
        args: ['configure-original'],
        env: { MODE: 'configure-original' },
        cwd: '',
        toolCallTimeoutMs: 10_000,
        reconnect: { ...reconnect },
      },
    }

    const configuring = ctx.mcpConnections.configure({
      desired,
      mutationId: mcpConnectionMutationId('detached-configure'),
      expectedRevision: 0,
    })
    desired.transport.args[0] = 'configure-queued-tamper'
    desired.transport.env.MODE = 'configure-queued-tamper'
    const configured = await configuring

    expect(ctx.mcpConnections.get(id)?.desired).toMatchObject({
      enabled: false,
      transport: { args: ['configure-original'], env: { MODE: 'configure-original' } },
    })
    desired.enabled = true
    desired.transport.args[0] = 'configure-post-commit-tamper'
    expect(ctx.mcpConnections.get(id)?.desired).toMatchObject({
      enabled: false,
      transport: { args: ['configure-original'] },
    })

    const transport = {
      transport: 'stdio' as const,
      command: process.execPath,
      args: ['update-original'],
      env: { MODE: 'update-original' },
      cwd: '',
      toolCallTimeoutMs: 20_000,
      reconnect: { ...reconnect },
    }
    const updating = ctx.mcpConnections.update({
      id,
      mutationId: mcpConnectionMutationId('detached-update'),
      expectedRevision: configured.revision,
      transport,
    })
    transport.args[0] = 'update-queued-tamper'
    transport.env.MODE = 'update-queued-tamper'
    await updating

    expect(ctx.mcpConnections.get(id)?.desired.transport).toMatchObject({
      args: ['update-original'],
      env: { MODE: 'update-original' },
    })
    transport.args[0] = 'update-post-commit-tamper'
    expect(ctx.mcpConnections.get(id)?.desired.transport).toMatchObject({ args: ['update-original'] })
  })

  it('rejects descriptor timers the runtime cannot schedule before persistence', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)
    const rejectedId = mcpConnectionId('delay-rejected')
    const valid = parseMcpConnectionDesired({
      id: rejectedId,
      enabled: false,
      transport: {
        transport: 'stdio',
        command: process.execPath,
        args: [],
        env: {},
        cwd: '',
        toolCallTimeoutMs: 10_000,
        reconnect,
      },
    })
    const oversized = {
      ...valid,
      transport: {
        ...valid.transport,
        reconnect: { ...valid.transport.reconnect, maxDelayMs: MAX_TIMER_DELAY_MS + 1 },
      },
    }
    expect(() => ctx.mcpConnections.configure({
      desired: oversized,
      mutationId: mcpConnectionMutationId('delay-rejected-configure'),
      expectedRevision: 0,
    })).toThrow(/maxDelayMs must not exceed 2147483647/)
    expect(ctx.mcpConnections.get(rejectedId)).toBeUndefined()
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })

    const configured = await ctx.mcpConnections.configure({
      desired: valid,
      mutationId: mcpConnectionMutationId('delay-valid-configure'),
      expectedRevision: 0,
    })
    expect(() => ctx.mcpConnections.update({
      id: rejectedId,
      mutationId: mcpConnectionMutationId('delay-rejected-update'),
      expectedRevision: configured.revision,
      transport: oversized.transport,
    })).toThrow(/maxDelayMs must not exceed 2147483647/)
    expect(ctx.mcpConnections.get(rejectedId)?.desired.transport.reconnect.maxDelayMs).toBe(100)
    expect(await readFile(path, 'utf8')).not.toContain(String(MAX_TIMER_DELAY_MS + 1))

    const oversizedToolTimeout = {
      ...valid,
      transport: { ...valid.transport, toolCallTimeoutMs: MAX_TIMER_DELAY_MS + 1 },
    }
    expect(() => ctx.mcpConnections.configure({
      desired: oversizedToolTimeout,
      mutationId: mcpConnectionMutationId('timeout-rejected-configure'),
      expectedRevision: 0,
    })).toThrow(/toolCallTimeoutMs must not exceed 2147483647/)
    expect(() => ctx.mcpConnections.update({
      id: rejectedId,
      mutationId: mcpConnectionMutationId('timeout-rejected-update'),
      expectedRevision: configured.revision,
      transport: oversizedToolTimeout.transport,
    })).toThrow(/toolCallTimeoutMs must not exceed 2147483647/)
    expect(ctx.mcpConnections.get(rejectedId)?.desired.transport.toolCallTimeoutMs).toBe(10_000)
  })

  it('detaches every scalar lifecycle request before queued mutation work begins', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)
    const alphaId = mcpConnectionId('alias-alpha')
    const betaId = mcpConnectionId('alias-beta')
    const configured = await ctx.mcpConnections.configure({
      desired: stdioDesired(alphaId, 'alpha'),
      mutationId: mcpConnectionMutationId('alias-alpha-configure'),
      expectedRevision: 0,
    })
    await ctx.mcpConnections.configure({
      desired: stdioDesired(betaId, 'beta'),
      mutationId: mcpConnectionMutationId('alias-beta-configure'),
      expectedRevision: 0,
    })

    const enableMutationId = mcpConnectionMutationId('alias-alpha-enable')
    const enableRequest = { id: alphaId, mutationId: enableMutationId, expectedRevision: configured.revision }
    const enabling = ctx.mcpConnections.enable(enableRequest)
    enableRequest.id = betaId
    const enabled = await enabling
    expect(enabled).toMatchObject({ id: alphaId, mutationId: enableMutationId, operation: 'enable' })
    expect(ctx.mcpConnections.get(alphaId)?.desired.enabled).toBe(true)
    expect(ctx.mcpConnections.get(betaId)?.desired.enabled).toBe(false)

    const disableMutationId = mcpConnectionMutationId('alias-alpha-disable')
    const disableRequest = { id: alphaId, mutationId: disableMutationId, expectedRevision: enabled.revision }
    const disabling = ctx.mcpConnections.disable(disableRequest)
    disableRequest.id = betaId
    const disabled = await disabling
    expect(disabled).toMatchObject({ id: alphaId, mutationId: disableMutationId, operation: 'disable' })
    expect(disabled.desiredDigest).toBe(configured.desiredDigest)
    expect(ctx.mcpConnections.get(alphaId)?.desired.enabled).toBe(false)
    expect(ctx.mcpConnections.get(betaId)?.desired.enabled).toBe(false)

    const removeMutationId = mcpConnectionMutationId('alias-alpha-remove')
    const removeRequest = { id: alphaId, mutationId: removeMutationId, expectedRevision: disabled.revision }
    const removing = ctx.mcpConnections.remove(removeRequest)
    removeRequest.id = betaId
    const removed = await removing
    expect(removed).toMatchObject({
      id: alphaId,
      mutationId: removeMutationId,
      operation: 'remove',
      desiredDigest: disabled.desiredDigest,
    })
    expect(ctx.mcpConnections.get(alphaId)).toBeUndefined()
    expect(ctx.mcpConnections.getRemoved(alphaId)?.desired.id).toBe(alphaId)
    expect(ctx.mcpConnections.get(betaId)).toBeDefined()

    const restoreMutationId = mcpConnectionMutationId('alias-alpha-restore')
    const restoreRequest = { id: alphaId, mutationId: restoreMutationId, expectedRevision: removed.revision }
    const restoring = ctx.mcpConnections.restore(restoreRequest)
    restoreRequest.id = betaId
    const restored = await restoring
    expect(restored).toMatchObject({
      id: alphaId,
      mutationId: restoreMutationId,
      operation: 'restore',
      desiredDigest: removed.desiredDigest,
    })
    expect(ctx.mcpConnections.get(alphaId)).toBeDefined()
    expect(ctx.mcpConnections.get(betaId)).toBeDefined()

    const removedAgain = await ctx.mcpConnections.remove({
      id: alphaId,
      mutationId: mcpConnectionMutationId('alias-alpha-remove-again'),
      expectedRevision: restored.revision,
    })
    const purgeMutationId = mcpConnectionMutationId('alias-alpha-purge')
    const purgeRequest = { id: alphaId, mutationId: purgeMutationId, expectedRevision: removedAgain.revision }
    const purging = ctx.mcpConnections.purge(purgeRequest)
    purgeRequest.id = betaId
    const purged = await purging
    expect(purged).toMatchObject({
      id: alphaId,
      mutationId: purgeMutationId,
      operation: 'purge',
      desiredDigest: null,
    })
    expect(ctx.mcpConnections.getRemoved(alphaId)).toBeUndefined()
    expect(ctx.mcpConnections.get(betaId)).toBeDefined()
  })

  it('enforces record CAS and durable exact-request idempotency', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)
    const id = mcpConnectionId('stable')
    const mutationId = mcpConnectionMutationId('stable-configure')
    const request = { desired: stdioDesired(id, 'v1'), mutationId, expectedRevision: 0 as const }
    const first = await ctx.mcpConnections.configure(request)
    const revisionAfterFirst = ctx.mcpConnections.snapshot().revision

    await mountForeignTool(ctx, 'mcp__stable__foreign')
    await expect(ctx.mcpConnections.configure(request)).resolves.toEqual(first)
    expect(ctx.mcpConnections.snapshot().revision).toBe(revisionAfterFirst)
    await expect(ctx.mcpConnections.configure({
      ...request,
      desired: stdioDesired(id, 'different'),
    })).rejects.toBeInstanceOf(McpConnectionIdempotencyError)
    await expect(ctx.mcpConnections.enable({
      id,
      mutationId: mcpConnectionMutationId('stale-enable'),
      expectedRevision: 0,
    })).rejects.toBeInstanceOf(McpConnectionConflictError)
    expect(ctx.mcpConnections.get(id)?.revision).toBe(first.revision)
  })

  it('binds an own __proto__ environment value into durable mutation idempotency', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)
    const id = mcpConnectionId('prototype-env')
    const mutationId = mcpConnectionMutationId('prototype-env-configure')
    const first = await ctx.mcpConnections.configure({
      desired: stdioDesiredWithPrototypeEnv(id, 'original'),
      mutationId,
      expectedRevision: 0,
    })

    await expect(ctx.mcpConnections.configure({
      desired: stdioDesiredWithPrototypeEnv(id, 'different'),
      mutationId,
      expectedRevision: 0,
    })).rejects.toBeInstanceOf(McpConnectionIdempotencyError)
    const transport = ctx.mcpConnections.get(id)?.desired.transport
    expect(transport).toMatchObject({ transport: 'stdio' })
    if (transport?.transport !== 'stdio') throw new Error('expected stored stdio transport')
    expect(Object.hasOwn(transport.env, '__proto__')).toBe(true)
    expect(transport.env['__proto__']).toBe('original')
    expect(ctx.mcpConnections.get(id)?.revision).toBe(first.revision)
  })

  it('repairs a truncated journal and restores a digest-corrupted descriptor from last-good', async () => {
    const path = await tempStatePath()
    const mounted = await mount(path)
    const id = mcpConnectionId('recoverable')
    await mounted.ctx.mcpConnections.configure({
      desired: stdioDesired(id, 'kept', true),
      mutationId: mcpConnectionMutationId('recoverable-configure'),
      expectedRevision: 0,
    })
    await mounted.fiber.dispose()

    await appendFile(`${path}.journal`, '{"partial":')
    const repairedJournal = await mount(path)
    expect(repairedJournal.ctx.tools.get('mcp__recoverable__kept')).toBeDefined()
    await repairedJournal.fiber.dispose()
    const journalEvidence = (await readdir(join(path, '..'))).filter(name => name.includes('.journal.corrupt-'))
    expect(journalEvidence).toHaveLength(1)
    expect((await readFile(`${path}.journal`, 'utf8')).endsWith('\n')).toBe(true)

    const envelope = JSON.parse(await readFile(path, 'utf8')) as { state: { connections: Array<{ desired: { transport: { command: string } } }> } }
    envelope.state.connections[0]!.desired.transport.command = 'tampered-without-digest'
    await writeFile(path, `${JSON.stringify(envelope)}\n`, { mode: 0o600 })

    const repairedState = await mount(path)
    expect(repairedState.ctx.tools.get('mcp__recoverable__kept')).toBeDefined()
    expect(repairedState.ctx.tools.get('mcp__recoverable__tampered-without-digest')).toBeUndefined()
    const stateEvidence = (await readdir(join(path, '..'))).filter(name => name.startsWith('connections.json.corrupt-'))
    expect(stateEvidence).toHaveLength(1)
  })

  it('fails boot when current and last-good descriptor files are both corrupt', async () => {
    const path = await tempStatePath()
    const mounted = await mount(path)
    const id = mcpConnectionId('lost')
    await mounted.ctx.mcpConnections.configure({
      desired: stdioDesired(id, 'tool'),
      mutationId: mcpConnectionMutationId('lost-configure'),
      expectedRevision: 0,
    })
    await mounted.fiber.dispose()
    await writeFile(path, '{broken', { mode: 0o600 })
    await writeFile(`${path}.last-good`, '{also-broken', { mode: 0o600 })

    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = ctx.plugin(LocalMcpConnections, { path })
    await expect(fiber).rejects.toThrow(/current and last-good state are corrupt/)
    await fiber.dispose()
  })

  it('retains a non-quiescent generation and retries teardown for Error and non-Error rejections', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)
    const provider = originalLocalProvider(ctx)
    const internals = provider as unknown as {
      live: Map<string, {
        fiber: Fiber
        desiredRevision: number
        generation: number
        tools: Map<string, unknown>
      }>
    }
    const failures: ReadonlyArray<readonly [string, unknown, string, 'disable' | 'remove']> = [
      ['error-dispose', new Error('dispose failed'), 'Error: dispose failed', 'disable'],
      ['string-dispose', 'dispose failed as text', 'dispose failed as text', 'disable'],
      ['remove-dispose', new Error('remove dispose failed'), '', 'remove'],
    ]

    for (const [rawId, failure, diagnostic, operation] of failures) {
      const id = mcpConnectionId(rawId)
      const configured = await provider.configure({
        desired: stdioDesired(id, 'tool', true),
        mutationId: mcpConnectionMutationId(`${rawId}-configure`),
        expectedRevision: 0,
      })
      const live = internals.live.get(id)
      if (live === undefined) throw new Error(`missing live fixture ${id}`)
      const actualFiber = live.fiber
      const failingDispose = vi.fn(async () => { throw failure })
      internals.live.set(id, {
        ...live,
        fiber: { dispose: failingDispose } as unknown as Fiber,
      })

      const request = {
        id,
        mutationId: mcpConnectionMutationId(`${rawId}-${operation}`),
        expectedRevision: configured.revision,
      }
      const firstAttempt = operation === 'disable' ? provider.disable(request) : provider.remove(request)
      await expect(firstAttempt).rejects.toThrow(/did not quiesce/)
      expect(failingDispose).toHaveBeenCalledOnce()
      if (operation === 'disable') {
        expect(provider.get(id)).toMatchObject({
          observed: { state: 'error', message: diagnostic },
          tools: { names: [`mcp__${rawId}__tool`] },
        })
      } else {
        expect(provider.get(id)).toBeUndefined()
      }
      const stillRunning = ctx.tools.get(`mcp__${rawId}__tool`)
      expect(stillRunning).toBeDefined()
      expect(await stillRunning?.execute({}, {
        signal: AbortSignal.timeout(2_000),
      } as unknown as Parameters<NonNullable<typeof stillRunning>['execute']>[1])).toMatchObject({
        content: [{ type: 'text', text: 'tool' }],
      })

      const retained = internals.live.get(id)
      if (retained === undefined) throw new Error(`missing retained live fixture ${id}`)
      internals.live.set(id, { ...retained, fiber: actualFiber })
      const retry = operation === 'disable' ? provider.disable(request) : provider.remove(request)
      await expect(retry).resolves.toMatchObject({ operation })
      expect(ctx.tools.get(`mcp__${rawId}__tool`)).toBeUndefined()
      if (operation === 'disable') {
        expect(provider.get(id)).toMatchObject({
          observed: { state: 'disabled' },
          tools: { names: [] },
        })
      }
    }
  })

  it('rejects activation when failed-generation cleanup rejects and retries the retained cleanup', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)
    const provider = originalLocalProvider(ctx)
    const internals = provider as unknown as {
      ownerContext: Context
      live: Map<string, { fiber: Fiber }>
    }
    const originalIsolate = internals.ownerContext.isolate.bind(internals.ownerContext)
    let restoreManagedDispose: (() => void) | undefined
    const isolateSpy = vi.spyOn(internals.ownerContext, 'isolate').mockImplementation((name, label) => {
      const isolated = originalIsolate(name, label)
      const originalPlugin = isolated.plugin.bind(isolated)
      vi.spyOn(isolated, 'plugin').mockImplementation((plugin, config) => {
        const fiber = originalPlugin(plugin, config)
        if (restoreManagedDispose === undefined) {
          const dispose = fiber.dispose.bind(fiber)
          Object.defineProperty(fiber, 'dispose', {
            configurable: true,
            value: vi.fn(async () => { throw new Error('managed cleanup refused') }),
          })
          restoreManagedDispose = () => {
            Object.defineProperty(fiber, 'dispose', { configurable: true, value: dispose })
          }
        }
        return fiber
      })
      return isolated
    })
    const id = mcpConnectionId('activation-cleanup')
    const request = {
      desired: parseMcpConnectionDesired({
        ...stdioDesired(id, 'tool', true),
        transport: {
          ...stdioDesired(id, 'tool', true).transport,
          command: join(path, '..', 'missing-activation-command'),
        },
      }),
      mutationId: mcpConnectionMutationId('activation-cleanup-configure'),
      expectedRevision: 0 as const,
    }

    await expect(provider.configure(request)).rejects.toBeInstanceOf(AggregateError)
    expect(internals.live.has(id)).toBe(true)
    expect(provider.get(id)).toMatchObject({
      observed: { state: 'error' },
      tools: { names: [] },
    })
    expect(provider.get(id)?.observed.message).toContain('did not quiesce')

    restoreManagedDispose?.()
    isolateSpy.mockRestore()
    await expect(provider.configure(request)).resolves.toMatchObject({ operation: 'configure' })
    expect(internals.live.has(id)).toBe(false)
    expect(provider.get(id)).toMatchObject({
      observed: { state: 'error' },
      tools: { names: [] },
    })
    expect(provider.get(id)?.observed.message).toContain('initial connection')
  })

  it('releases a transferred namespace reservation when replacement activation rejects before adoption', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)
    const provider = originalLocalProvider(ctx)
    const internals = provider as unknown as {
      assertToolNamespaceAvailable(id: string): void
      live: Map<string, {
        reservation: DirectMcpClient.McpServerNameReservation
      }>
    }
    const id = mcpConnectionId('transfer-rejected')
    const configured = await provider.configure({
      desired: stdioDesired(id, 'first', true),
      mutationId: mcpConnectionMutationId('transfer-rejected-configure'),
      expectedRevision: 0,
    })
    const live = internals.live.get(id)
    if (live === undefined) throw new Error('missing transferred-reservation fixture')
    const originalReservation = live.reservation
    const release = vi.fn(originalReservation.release.bind(originalReservation))
    live.reservation = { token: originalReservation.token, release }
    const assertNamespace = internals.assertToolNamespaceAvailable.bind(internals)
    const failure = new Error('injected namespace scan failure')
    internals.assertToolNamespaceAvailable = () => { throw failure }
    const request = {
      id,
      mutationId: mcpConnectionMutationId('transfer-rejected-update'),
      expectedRevision: configured.revision,
      transport: stdioDesired(id, 'second').transport,
    }

    await expect(provider.update(request)).rejects.toBe(failure)
    expect(release).toHaveBeenCalledOnce()
    expect(internals.live.has(id)).toBe(false)

    internals.assertToolNamespaceAvailable = assertNamespace
    await expect(provider.update(request)).resolves.toMatchObject({ operation: 'update' })
    expect(ctx.tools.get('mcp__transfer-rejected__second')).toBeDefined()
  })

  it('attempts every owner cleanup, aggregates failures, and retains only non-quiescent generations', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)
    const provider = originalLocalProvider(ctx)
    const internals = provider as unknown as {
      live: Map<string, {
        fiber: Fiber
        desiredRevision: number
        generation: number
        tools: Map<string, unknown>
      }>
    }
    const retainedId = mcpConnectionId('owner-retained')
    const releasedId = mcpConnectionId('owner-released')
    for (const id of [retainedId, releasedId]) {
      await provider.configure({
        desired: stdioDesired(id, 'tool', true),
        mutationId: mcpConnectionMutationId(`${id}-configure`),
        expectedRevision: 0,
      })
    }
    const retained = internals.live.get(retainedId)
    const released = internals.live.get(releasedId)
    if (retained === undefined || released === undefined) throw new Error('missing owner cleanup fixtures')
    const retainedFiber = retained.fiber
    const retainedDispose = vi.fn(async () => { throw new Error('still running') })
    const releasedDispose = vi.fn(released.fiber.dispose.bind(released.fiber))
    internals.live.set(retainedId, {
      ...retained,
      fiber: { dispose: retainedDispose } as unknown as Fiber,
    })
    internals.live.set(releasedId, {
      ...released,
      fiber: { dispose: releasedDispose } as unknown as Fiber,
    })

    const lifecycle = provider[Service.init]()
    const yielded = await lifecycle.next()
    if (yielded.done || typeof yielded.value !== 'function') throw new Error('missing owner disposer')
    const ownerDispose = yielded.value
    await expect(ownerDispose()).rejects.toBeInstanceOf(AggregateError)
    expect(retainedDispose).toHaveBeenCalledOnce()
    expect(releasedDispose).toHaveBeenCalledOnce()
    expect(internals.live.has(retainedId)).toBe(true)
    expect(internals.live.has(releasedId)).toBe(false)
    expect(ctx.tools.get('mcp__owner-retained__tool')).toBeDefined()
    expect(ctx.tools.get('mcp__owner-released__tool')).toBeUndefined()

    const retainedAfterFailure = internals.live.get(retainedId)
    if (retainedAfterFailure === undefined) throw new Error('missing retained owner generation')
    internals.live.set(retainedId, { ...retainedAfterFailure, fiber: retainedFiber })
    await expect(ownerDispose()).resolves.toBeUndefined()
    expect(internals.live.size).toBe(0)
    expect(ctx.tools.get('mcp__owner-retained__tool')).toBeUndefined()
    await lifecycle.return()
  })

  it('coalesces tool refreshes, stops queued refreshes at disposal, and logs refresh failures', async () => {
    const path = await tempStatePath()
    const { ctx } = await mount(path)
    const provider = originalLocalProvider(ctx)
    const internals = provider as unknown as {
      stopped: boolean
      queueToolRefresh(): void
      refreshAllToolGenerations(announce: boolean): void
    }

    internals.queueToolRefresh()
    internals.queueToolRefresh()
    await settleToolRefresh()

    internals.queueToolRefresh()
    internals.stopped = true
    await settleToolRefresh()
    internals.queueToolRefresh()
    internals.stopped = false

    const failure = new Error('refresh failed')
    const originalRefresh = internals.refreshAllToolGenerations.bind(internals)
    internals.refreshAllToolGenerations = () => { throw failure }
    const logged = vi.spyOn(ctx.logger, 'error')
    internals.queueToolRefresh()
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalledWith('mcp-connections-local: tool-generation refresh failed')
      expect(logged).toHaveBeenCalledWith(failure)
    })
    internals.refreshAllToolGenerations = originalRefresh
  })

  it('rejects new mutations after provider disposal', async () => {
    const path = await tempStatePath()
    const { ctx, fiber } = await mount(path)
    const provider = ctx.mcpConnections
    await fiber.dispose()

    await expect(provider.configure({
      desired: stdioDesired('disposed', 'tool'),
      mutationId: mcpConnectionMutationId('disposed-configure'),
      expectedRevision: 0,
    })).rejects.toThrow(/provider is disposed/)
  })
})

describe('parser compatibility used by the local provider', () => {
  it('bounds the cross-process writer wait', () => {
    expect(LocalMcpConnections.Config({})).toMatchObject({
      lockWaitMs: DEFAULT_MCP_STATE_LOCK_WAIT_MS,
    })
    expect(LocalMcpConnections.Config({ lockWaitMs: MAX_MCP_STATE_LOCK_WAIT_MS }).lockWaitMs)
      .toBe(MAX_MCP_STATE_LOCK_WAIT_MS)
    for (const lockWaitMs of [-1, 1.5, MAX_MCP_STATE_LOCK_WAIT_MS + 1]) {
      expect(() => LocalMcpConnections.Config({ lockWaitMs })).toThrow()
    }
  })

  it('resolves the default state path under the selected Harness home', async () => {
    const path = await tempStatePath()
    const dshHome = join(path, '..')
    expect(resolveSpec({ dshHome })).toEqual({
      statePath: resolve(dshHome, 'mcp', 'connections.json'),
      lockWaitMs: DEFAULT_MCP_STATE_LOCK_WAIT_MS,
    })
    expect(resolveSpec({ path, lockWaitMs: 0 })).toEqual({ statePath: resolve(path), lockWaitMs: 0 })
  })

  it('keeps update transports fully resolved before they reach mcp-client', () => {
    expect(parseMcpTransportDescriptor(stdioDesired('resolved', 'tool').transport)).toEqual(
      stdioDesired('resolved', 'tool').transport,
    )
  })
})
