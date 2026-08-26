/**
 * Local durable provider for `ctx.mcpConnections`. Enabled desired records
 * mount the existing mcp-client plugin dynamically, so its connection
 * supervisor owns reconnect, tool synchronization, and quiescent teardown.
 * @module @deepseek-ai/dsh-mcp-connections-local
 */

import { Context, Service, symbols, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { join, resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type {
  Config as McpClientConfig,
  McpServerNameReservation,
} from '@deepseek-ai/dsh-mcp-client'
import {
  McpConnectionConflictError,
  McpConnectionNotFoundError,
  McpConnections,
  parseMcpConnectionDesired,
  parseMcpTransportDescriptor,
  type ConfigureMcpConnectionRequest,
  type McpConnectionDesired,
  type McpConnectionId,
  type McpConnectionMutationId,
  type McpConnectionMutationReceipt,
  type McpConnectionMutationRequest,
  type McpConnectionObserved,
  type McpConnectionOperation,
  type McpConnectionsSnapshot,
  type McpConnectionView,
  type McpToolGeneration,
  type RemovedMcpConnectionView,
  type RestoreMcpConnectionRequest,
  type UpdateMcpConnectionRequest,
} from '@deepseek-ai/dsh-mcp-connections'
import type { ToolDefinition, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { McpConnectionFileStore } from './persistence.ts'
import {
  DEFAULT_MCP_STATE_LOCK_WAIT_MS,
  MAX_MCP_STATE_LOCK_WAIT_MS,
} from './coordinator.ts'
import {
  compareCodeUnits,
  digestCanonical,
  digestDesired,
  emptyStoredState,
  normalizeStoredState,
  type StoredMcpConnection,
  type StoredMcpConnectionsState,
  type StoredRemovedMcpConnection,
} from './state.ts'

/** Local provider configuration. */
export interface Config {
  /** Absolute or cwd-relative desired-state file; defaults under the Harness home. */
  readonly path?: string
  /** Harness home used only when `path` is omitted. */
  readonly dshHome?: string
  /** Maximum wait for another process's MCP desired-state writer. */
  readonly lockWaitMs?: number
}

interface ResolvedSpec {
  statePath: string
  lockWaitMs: number
}

interface LiveConnection {
  fiber: Fiber
  reservation: McpServerNameReservation
  desiredRevision: number
  generation: number
  tools: Map<string, ToolDefinition>
  cleanupPending: boolean
}

interface PendingActivationReservation {
  readonly id: McpConnectionId
  value: McpServerNameReservation | undefined
}

interface ManagedToolsConfig {
  upstream: ToolRuntime
  namespacePrefix: string
  tools: Map<string, ToolDefinition>
}

const EMPTY_TOOL_DIGEST = digestCanonical([])
const MAX_DIAGNOSTIC_CODE_UNITS = 512

/** Isolated tool-service facade that records registrations owned by one managed MCP Fiber. */
class ManagedMcpTools extends Service {
  private readonly upstream: ToolRuntime
  private readonly namespacePrefix: string
  private readonly tools: Map<string, ToolDefinition>

  constructor(ctx: Context, config: ManagedToolsConfig) {
    super(ctx, 'tools')
    this.upstream = config.upstream
    this.namespacePrefix = config.namespacePrefix
    this.tools = config.tools
  }

  /** Register one managed MCP tool in the shared runtime and retain exact Fiber provenance. */
  register(definition: ToolDefinition): () => void {
    /* v8 ignore next -- mcp-client constructs every registration with this exact server namespace. */
    if (!definition.name.startsWith(this.namespacePrefix)) {
      throw new Error(`mcp-connections-local: managed MCP tool ${JSON.stringify(definition.name)} is outside namespace ${JSON.stringify(this.namespacePrefix)}`)
    }
    const upstream = this.ctx.reflect.trace(this.upstream)
    // oxlint-disable-next-line typescript/no-misused-promises -- ToolRuntime cleanup is synchronous; Cordis owns its settled wrapper
    return this.ctx.effect(() => {
      const dispose = upstream.register(definition)
      this.tools.set(definition.name, definition)
      return () => {
        dispose()
        /* v8 ignore next -- mcp-client disposes each generation before registering its replacement. */
        if (this.tools.get(definition.name) === definition) this.tools.delete(definition.name)
      }
    }, 'mcp-connections-local.managedTool()')
  }
}

/**
 * Resolve the one authoritative local state path.
 * @param config - optional explicit file or Harness-home selector.
 * @returns the absolute state-file specification.
 */
export function resolveSpec(config: Config): ResolvedSpec {
  return {
    statePath: resolve(config.path ?? join(resolveDshHome(config.dshHome), 'mcp', 'connections.json')),
    lockWaitMs: config.lockWaitMs ?? DEFAULT_MCP_STATE_LOCK_WAIT_MS,
  }
}

/** File-backed desired-state provider and owner of dynamic mcp-client fibers. */
export class LocalMcpConnections extends McpConnections {
  static inject = ['tools']

  /** Loader schema for the state location. */
  static Config: z<Config> = z.object({
    path: z.string(),
    dshHome: z.string(),
    lockWaitMs: z.number().step(1).min(0).max(MAX_MCP_STATE_LOCK_WAIT_MS)
      .default(DEFAULT_MCP_STATE_LOCK_WAIT_MS),
  })

  /** Runtime API revision implemented by this provider. */
  readonly protocolVersion = 1 as const

  private readonly ownerContext: Context
  private readonly store: McpConnectionFileStore
  private state = emptyStoredState()
  private readonly live = new Map<McpConnectionId, LiveConnection>()
  private readonly observed = new Map<McpConnectionId, McpConnectionObserved>()
  private readonly toolGenerations = new Map<McpConnectionId, McpToolGeneration>()
  private readonly runtimeGenerations = new Map<McpConnectionId, number>()
  private operations: Promise<void> = Promise.resolve()
  private toolRefreshQueued = false
  private stopped = false

  /** Create a provider; durable loading and live reconciliation run during service initialization. */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.ownerContext = ctx
    const spec = resolveSpec(config)
    this.store = new McpConnectionFileStore(spec.statePath, spec.lockWaitMs)
    ctx.on('tools/change', () => { this.queueToolRefresh() })
  }

  /** Load desired state, repair recoverable files, and activate enabled records before injection completes. */
  async* [Service.init](): AsyncGenerator<() => Promise<void>, void, void> {
    yield async () => {
      this.stopped = true
      await this.operations
      const connections = [...this.live]
      const settled = await Promise.allSettled(connections.map(([, connection]) => connection.fiber.dispose()))
      const failures: unknown[] = []
      const failedIds: McpConnectionId[] = []
      for (const [index, result] of settled.entries()) {
        const entry = connections.at(index)
        /* v8 ignore next -- Promise.allSettled preserves the input length and order. */
        if (entry === undefined) throw new Error('mcp-connections-local: owner cleanup result has no connection')
        const [id, connection] = entry
        if (result.status === 'fulfilled') {
          /* v8 ignore else -- stopped providers serialize all map mutation before owner cleanup starts. */
          if (this.live.get(id) === connection) {
            this.live.delete(id)
            connection.reservation.release()
          }
        } else {
          failures.push(result.reason)
          failedIds.push(id)
        }
      }
      this.refreshAllToolGenerations(false)
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `mcp-connections-local: owner cleanup did not quiesce ${failedIds.map(id => JSON.stringify(id)).join(', ')}`,
        )
      }
    }
    const loaded = await this.store.load()
    this.state = loaded.state
    this.reportRecoveries(loaded.recoveries)
    await this.reconcileAll()
  }

  /** Return an immutable active and removed inventory. */
  snapshot(): McpConnectionsSnapshot {
    return freeze({
      revision: this.state.revision,
      connections: this.state.connections.map(record => this.viewOf(record)),
      removed: this.state.removed.map(record => this.removedViewOf(record)),
    })
  }

  /** Return one immutable active view. */
  get(id: McpConnectionId): McpConnectionView | undefined {
    const record = this.state.connections.find(entry => entry.desired.id === id)
    return record === undefined ? undefined : this.viewOf(record)
  }

  /** Return one immutable restorable removed record. */
  getRemoved(id: McpConnectionId): RemovedMcpConnectionView | undefined {
    const record = this.state.removed.find(entry => entry.desired.id === id)
    return record === undefined ? undefined : this.removedViewOf(record)
  }

  /** Persist a new desired record and activate it when enabled. */
  configure(request: ConfigureMcpConnectionRequest): Promise<McpConnectionMutationReceipt> {
    const detachedRequest = freeze({
      ...request,
      desired: parseMcpConnectionDesired(request.desired),
    })
    const operation = 'configure' as const
    return this.runMutation(operation, detachedRequest.mutationId, { operation, ...detachedRequest }, (state) => {
      const id = detachedRequest.desired.id
      const active = findConnection(state, id)
      const removed = findRemoved(state, id)
      const existing = active ?? removed
      if (existing !== undefined) {
        throw new McpConnectionConflictError(id, detachedRequest.expectedRevision, existing.revision)
      }
      const snapshotRevision = state.revision + 1
      const record: StoredMcpConnection = { desired: detachedRequest.desired, revision: 1 }
      state.revision = snapshotRevision
      state.connections.push(record)
      return receiptFor(operation, detachedRequest.mutationId, record, snapshotRevision, true)
    }, () => this.reserveNamespaceAvailable(detachedRequest.desired.id))
  }

  /** Persist enabled desired state and activate the connection. */
  enable(request: McpConnectionMutationRequest): Promise<McpConnectionMutationReceipt> {
    return this.setEnabled('enable', request, true)
  }

  /** Persist disabled desired state and wait for the mcp-client fiber to dispose. */
  disable(request: McpConnectionMutationRequest): Promise<McpConnectionMutationReceipt> {
    return this.setEnabled('disable', request, false)
  }

  /** Persist a replacement transport and restart an enabled mcp-client fiber. */
  update(request: UpdateMcpConnectionRequest): Promise<McpConnectionMutationReceipt> {
    const detachedRequest = freeze({
      ...request,
      transport: parseMcpTransportDescriptor(request.transport),
    })
    const operation = 'update' as const
    return this.runMutation(operation, detachedRequest.mutationId, { operation, ...detachedRequest }, (state) => {
      const record = requireActive(state, detachedRequest.id)
      assertExpected(record, detachedRequest.expectedRevision)
      const changed = digestCanonical(record.desired.transport) !== digestCanonical(detachedRequest.transport)
      const previousRevision = record.revision
      if (changed) {
        record.desired = { ...record.desired, transport: detachedRequest.transport }
        record.revision += 1
      }
      state.revision += 1
      return receiptFor(operation, detachedRequest.mutationId, record, state.revision, changed, previousRevision)
    })
  }

  /** Move an active record to the removed inventory and wait for its tools to disappear. */
  remove(request: McpConnectionMutationRequest): Promise<McpConnectionMutationReceipt> {
    const detachedRequest = freeze(request)
    const operation = 'remove' as const
    return this.runMutation(operation, detachedRequest.mutationId, { operation, ...detachedRequest }, (state) => {
      const record = requireActive(state, detachedRequest.id)
      assertExpected(record, detachedRequest.expectedRevision)
      const previousRevision = record.revision
      state.revision += 1
      const removed: StoredRemovedMcpConnection = {
        desired: record.desired,
        revision: record.revision + 1,
        removedAtRevision: state.revision,
      }
      state.connections = state.connections.filter(entry => entry.desired.id !== detachedRequest.id)
      state.removed.push(removed)
      return receiptFor(operation, detachedRequest.mutationId, removed, state.revision, true, previousRevision)
    })
  }

  /** Restore a removed record and reactivate its retained enabled state. */
  restore(request: RestoreMcpConnectionRequest): Promise<McpConnectionMutationReceipt> {
    const detachedRequest = freeze(request)
    const operation = 'restore' as const
    let reservesNamespace = false
    return this.runMutation(operation, detachedRequest.mutationId, { operation, ...detachedRequest }, (state) => {
      const removed = requireRemoved(state, detachedRequest.id)
      assertExpected(removed, detachedRequest.expectedRevision)
      reservesNamespace = removed.desired.enabled
      const previousRevision = removed.revision
      state.revision += 1
      const restored: StoredMcpConnection = { desired: removed.desired, revision: removed.revision + 1 }
      state.removed = state.removed.filter(entry => entry.desired.id !== detachedRequest.id)
      state.connections.push(restored)
      return receiptFor(operation, detachedRequest.mutationId, restored, state.revision, true, previousRevision)
    }, () => reservesNamespace ? this.reserveNamespaceAvailable(detachedRequest.id) : undefined)
  }

  /** Permanently delete one removed record without changing any live runtime. */
  purge(request: McpConnectionMutationRequest): Promise<McpConnectionMutationReceipt> {
    const detachedRequest = freeze(request)
    const operation = 'purge' as const
    return this.runMutation(operation, detachedRequest.mutationId, { operation, ...detachedRequest }, (state) => {
      const removed = requireRemoved(state, detachedRequest.id)
      assertExpected(removed, detachedRequest.expectedRevision)
      const previousRevision = removed.revision
      state.revision += 1
      state.removed = state.removed.filter(entry => entry.desired.id !== detachedRequest.id)
      return {
        mutationId: detachedRequest.mutationId,
        operation,
        id: detachedRequest.id,
        previousRevision,
        revision: previousRevision + 1,
        snapshotRevision: state.revision,
        changed: true,
        desiredDigest: null,
      }
    })
  }

  private setEnabled(
    operation: 'enable' | 'disable',
    request: McpConnectionMutationRequest,
    enabled: boolean,
  ): Promise<McpConnectionMutationReceipt> {
    const detachedRequest = freeze(request)
    let reservesNamespace = false
    return this.runMutation(operation, detachedRequest.mutationId, { operation, ...detachedRequest }, (state) => {
      const record = requireActive(state, detachedRequest.id)
      assertExpected(record, detachedRequest.expectedRevision)
      reservesNamespace = enabled && !this.live.has(detachedRequest.id)
      const changed = record.desired.enabled !== enabled
      const previousRevision = record.revision
      if (changed) {
        record.desired = { ...record.desired, enabled }
        record.revision += 1
      }
      state.revision += 1
      return receiptFor(operation, detachedRequest.mutationId, record, state.revision, changed, previousRevision)
    }, () => reservesNamespace ? this.reserveNamespaceAvailable(detachedRequest.id) : undefined)
  }

  private runMutation(
    operation: McpConnectionOperation,
    mutationId: McpConnectionMutationId,
    requestValue: unknown,
    transform: (state: StoredMcpConnectionsState) => McpConnectionMutationReceipt,
    reserveCommit?: () => McpServerNameReservation | undefined,
  ): Promise<McpConnectionMutationReceipt> {
    return this.enqueue(async () => {
      let reservation: McpServerNameReservation | undefined
      let pending: PendingActivationReservation | undefined
      try {
        const result = await this.store.mutate(mutationId, digestCanonical(requestValue), (state) => {
          const receipt = transform(state)
          normalizeStoredState(state)
          return { next: state, receipt }
        }, () => { reservation = reserveCommit?.() })
        this.state = result.state
        this.reportRecoveries(result.recoveries)
        if (!result.replayed && result.receipt.changed) {
          if (operation === 'remove') {
            this.announce({ kind: 'removed', id: result.receipt.id })
          } else if (operation === 'purge') {
            this.announce({ kind: 'purged', id: result.receipt.id })
          } else {
            const view = this.get(result.receipt.id)
            /* v8 ignore next -- these mutations commit the same active record identified by their receipt. */
            if (view === undefined) throw new Error(`mcp-connections-local: committed connection "${result.receipt.id}" is absent`)
            this.announce({ kind: 'desired', id: result.receipt.id, view })
          }
        }
        pending = reservation === undefined ? undefined : { id: result.receipt.id, value: reservation }
        await this.reconcileAll(pending)
        return result.receipt
      } finally {
        if (pending === undefined) reservation?.release()
        else pending.value?.release()
      }
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('mcp-connections-local: provider is disposed'))
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  private async reconcileAll(pending?: PendingActivationReservation): Promise<void> {
    const desiredById = new Map(this.state.connections.map(record => [record.desired.id, record] as const))
    const transferred = new Map<McpConnectionId, McpServerNameReservation>()
    try {
      for (const [id, live] of [...this.live]) {
        const record = desiredById.get(id)
        if (live.cleanupPending || record === undefined || !record.desired.enabled || record.revision !== live.desiredRevision) {
          const reservation = await this.deactivate(id, live, record, record?.desired.enabled === true)
          if (reservation !== undefined) transferred.set(id, reservation)
        }
      }
      for (const record of this.state.connections) {
        if (record.desired.enabled && !this.live.has(record.desired.id)) {
          const transferredReservation = transferred.get(record.desired.id)
          const pendingReservation = pending?.id === record.desired.id ? pending.value : undefined
          const reservation = transferredReservation ?? pendingReservation
          await this.activate(record, reservation, () => {
            if (transferredReservation !== undefined) transferred.delete(record.desired.id)
            if (pendingReservation !== undefined && pending !== undefined) pending.value = undefined
          })
        }
        if (!record.desired.enabled && !this.live.has(record.desired.id)) {
          this.publishObserved(record, {
            state: 'disabled',
            desiredRevision: record.revision,
            generation: this.runtimeGenerations.get(record.desired.id) ?? 0,
          })
        }
      }
      this.refreshAllToolGenerations(true)
    } finally {
      for (const reservation of transferred.values()) reservation.release()
    }
  }

  private async activate(
    record: StoredMcpConnection,
    suppliedReservation?: McpServerNameReservation,
    reservationAdopted?: () => void,
  ): Promise<void> {
    const id = record.desired.id
    let reservation: McpServerNameReservation
    if (suppliedReservation === undefined) {
      reservation = this.reserveNamespaceAvailable(id)
    } else {
      this.assertToolNamespaceAvailable(id)
      reservation = suppliedReservation
    }
    const generation = (this.runtimeGenerations.get(id) ?? 0) + 1
    this.runtimeGenerations.set(id, generation)
    this.publishObserved(record, { state: 'connecting', desiredRevision: record.revision, generation })
    const tools = new Map<string, ToolDefinition>()
    const managedContext = this.ownerContext.isolate('tools')
    const fiber = managedContext.plugin(ManagedMcpTools, {
      upstream: originalService(this.ownerContext.tools),
      namespacePrefix: namespacePrefix(id),
      tools,
    })
    const live: LiveConnection = {
      fiber,
      reservation,
      desiredRevision: record.revision,
      generation,
      tools,
      cleanupPending: false,
    }
    this.live.set(id, live)
    reservationAdopted?.()
    try {
      await fiber
      await fiber.ctx.plugin({
        name: McpClient.name,
        inject: McpClient.inject,
        Config: McpClient.Config,
        apply(ctx: Context, config: McpClientConfig) {
          return McpClient.apply(ctx, config, reservation)
        },
      }, toClientConfig(record.desired))
      this.refreshToolGeneration(id, true)
      this.publishObserved(record, { state: 'ready', desiredRevision: record.revision, generation })
    } catch (activationError) {
      live.cleanupPending = true
      let cleanupFailed = false
      let cleanupError: unknown
      try {
        await fiber.dispose()
      } catch (error) {
        cleanupFailed = true
        cleanupError = error
      }
      if (cleanupFailed) {
        this.refreshToolGeneration(id, true)
        const failure = new AggregateError(
          [activationError, cleanupError],
          `mcp-connections-local: activation failed and generation ${String(generation)} did not quiesce`,
          { cause: activationError },
        )
        this.publishObserved(record, {
          state: 'error',
          desiredRevision: record.revision,
          generation,
          message: sanitizeDiagnostic(failure),
        })
        throw failure
      }
      this.live.delete(id)
      reservation.release()
      this.refreshToolGeneration(id, true)
      this.publishObserved(record, {
        state: 'error',
        desiredRevision: record.revision,
        generation,
        message: sanitizeDiagnostic(activationError),
      })
    }
  }

  private async deactivate(
    id: McpConnectionId,
    live: LiveConnection,
    activeRecord: StoredMcpConnection | undefined,
    retainReservation: boolean,
  ): Promise<McpServerNameReservation | undefined> {
    const generation = live.generation
    if (activeRecord !== undefined) {
      this.publishObserved(activeRecord, {
        state: 'stopping',
        desiredRevision: activeRecord.revision,
        generation,
      })
    }
    let disposeFailed = false
    let disposeError: unknown
    try {
      await live.fiber.dispose()
    } catch (error) {
      disposeFailed = true
      disposeError = error
    }
    if (disposeFailed) {
      live.cleanupPending = true
      this.refreshToolGeneration(id, activeRecord !== undefined)
      if (activeRecord !== undefined) {
        this.publishObserved(activeRecord, {
          state: 'error',
          desiredRevision: activeRecord.revision,
          generation,
          message: sanitizeDiagnostic(disposeError),
        })
      }
      throw new Error(`mcp-connections-local: generation ${String(generation)} did not quiesce`, { cause: disposeError })
    }
    this.live.delete(id)
    if (!retainReservation) live.reservation.release()
    this.refreshToolGeneration(id, activeRecord !== undefined)
    if (activeRecord !== undefined) {
      this.publishObserved(activeRecord, {
        state: 'disabled',
        desiredRevision: activeRecord.revision,
        generation,
      })
    }
    return retainReservation ? live.reservation : undefined
  }

  private publishObserved(record: StoredMcpConnection, observed: McpConnectionObserved): void {
    const previous = this.observed.get(record.desired.id)
    if (previous !== undefined && digestCanonical(previous) === digestCanonical(observed)) return
    this.observed.set(record.desired.id, observed)
    this.announce({ kind: 'observed', id: record.desired.id, view: this.viewOf(record) })
  }

  private queueToolRefresh(): void {
    if (this.toolRefreshQueued || this.stopped) return
    this.toolRefreshQueued = true
    queueMicrotask(() => {
      this.toolRefreshQueued = false
      if (this.stopped) return
      void this.enqueue(() => {
        this.refreshAllToolGenerations(true)
        return Promise.resolve()
      }).catch((error: unknown) => {
        this.ownerContext.logger.error('mcp-connections-local: tool-generation refresh failed')
        this.ownerContext.logger.error(error)
      })
    })
  }

  private refreshAllToolGenerations(announce: boolean): void {
    const ids = new Set<McpConnectionId>([
      ...this.state.connections.map(record => record.desired.id),
      ...this.toolGenerations.keys(),
    ])
    for (const id of ids) this.refreshToolGeneration(id, announce && findConnection(this.state, id) !== undefined)
  }

  private refreshToolGeneration(id: McpConnectionId, announce: boolean): void {
    const live = this.live.get(id)
    const schemasByName = new Map(this.ownerContext.tools.schemas().map(schema => [schema.name, schema] as const))
    const schemas = live === undefined ? [] : [...live.tools]
      .flatMap(([name, definition]) => {
        /* v8 ignore next -- managed provenance is deleted before the upstream registration is disposed. */
        if (this.ownerContext.tools.get(name) !== definition) return []
        const schema = schemasByName.get(name)
        /* v8 ignore next -- ToolRuntime get() and schemas() project the same registered definition set. */
        return schema === undefined ? [] : [schema]
      })
      .sort((left, right) => compareCodeUnits(left.name, right.name))
    const digest = digestCanonical(schemas)
    const previous = this.toolGenerations.get(id)
    if (previous?.digest === digest) return
    const next: McpToolGeneration = freeze({
      generation: (previous?.generation ?? 0) + 1,
      digest,
      names: schemas.map(schema => schema.name),
    })
    this.toolGenerations.set(id, next)
    if (announce) {
      const record = findConnection(this.state, id)
      /* v8 ignore else -- announce is true only for an active desired id selected by the caller. */
      if (record !== undefined) this.announce({ kind: 'tools', id, view: this.viewOf(record) })
    }
  }

  private viewOf(record: StoredMcpConnection): McpConnectionView {
    const id = record.desired.id
    const observed = this.observed.get(id) ?? {
      state: record.desired.enabled ? 'connecting' : 'disabled',
      desiredRevision: record.revision,
      generation: this.runtimeGenerations.get(id) ?? 0,
    }
    return freeze({
      id,
      revision: record.revision,
      desired: record.desired,
      observed,
      tools: this.toolGenerations.get(id) ?? { generation: 0, digest: EMPTY_TOOL_DIGEST, names: [] },
    })
  }

  private removedViewOf(record: StoredRemovedMcpConnection): RemovedMcpConnectionView {
    return freeze({
      id: record.desired.id,
      revision: record.revision,
      desired: record.desired,
      removedAtRevision: record.removedAtRevision,
    })
  }

  private reportRecoveries(recoveries: readonly string[]): void {
    for (const recovery of recoveries) this.ownerContext.logger.warn(`mcp-connections-local: recovered durable state (${recovery})`)
  }

  private reserveNamespaceAvailable(id: McpConnectionId): McpServerNameReservation {
    this.assertToolNamespaceAvailable(id)
    return McpClient.reserveMcpServerName(this.ownerContext, id)
  }

  private assertToolNamespaceAvailable(id: McpConnectionId): void {
    const prefix = namespacePrefix(id)
    const collisions = this.ownerContext.tools.schemas()
      .map(schema => schema.name)
      .filter(name => name.startsWith(prefix))
      .sort(compareCodeUnits)
    if (collisions.length > 0) {
      throw new Error(`mcp-connections-local: cannot activate connection ${JSON.stringify(id)} because namespace ${JSON.stringify(prefix)} is occupied by non-owner tools: ${collisions.map(name => JSON.stringify(name)).join(', ')}; remove or rename those registrations first`)
    }
  }
}

function namespacePrefix(id: McpConnectionId): string {
  return `mcp__${id}__`
}

/** Strip one caller trace so the managed child context can own delegated registrations. */
function originalService<T extends object>(receiver: T): T {
  const original = (receiver as T & { [symbols.original]?: T })[symbols.original]
  /* v8 ignore next -- every Cordis-injected service receiver carries its untraced original. */
  if (original === undefined) throw new Error('mcp-connections-local: injected ToolRuntime has no original service')
  return original
}

function toClientConfig(
  desired: McpConnectionDesired,
): McpClientConfig {
  const common = {
    serverName: desired.id,
    toolCallTimeoutMs: desired.transport.toolCallTimeoutMs,
    failOnStartupError: true,
    reconnect: { ...desired.transport.reconnect },
  }
  if (desired.transport.transport === 'stdio') {
    return {
      ...common,
      transport: 'stdio',
      command: desired.transport.command,
      args: [...desired.transport.args],
      env: { ...desired.transport.env },
      cwd: desired.transport.cwd,
    }
  }
  return {
    ...common,
    transport: 'streamable-http',
    url: desired.transport.url,
    headers: { ...desired.transport.headers },
    redirect: desired.transport.redirect,
  }
}

function receiptFor(
  operation: McpConnectionOperation,
  mutationId: McpConnectionMutationId,
  record: StoredMcpConnection,
  snapshotRevision: number,
  changed: boolean,
  previousRevision?: number,
): McpConnectionMutationReceipt {
  return {
    mutationId,
    operation,
    id: record.desired.id,
    ...previousRevision === undefined ? {} : { previousRevision },
    revision: record.revision,
    snapshotRevision,
    changed,
    desiredDigest: digestDesired(record.desired),
  }
}

function requireActive(state: StoredMcpConnectionsState, id: McpConnectionId): StoredMcpConnection {
  const record = findConnection(state, id)
  if (record === undefined) throw new McpConnectionNotFoundError(id, 'active')
  return record
}

function requireRemoved(state: StoredMcpConnectionsState, id: McpConnectionId): StoredRemovedMcpConnection {
  const record = findRemoved(state, id)
  if (record === undefined) throw new McpConnectionNotFoundError(id, 'removed')
  return record
}

function findConnection(state: StoredMcpConnectionsState, id: McpConnectionId): StoredMcpConnection | undefined {
  return state.connections.find(record => record.desired.id === id)
}

function findRemoved(state: StoredMcpConnectionsState, id: McpConnectionId): StoredRemovedMcpConnection | undefined {
  return state.removed.find(record => record.desired.id === id)
}

function assertExpected(record: StoredMcpConnection, expected: number): void {
  if (record.revision !== expected) throw new McpConnectionConflictError(record.desired.id, expected, record.revision)
}

function sanitizeDiagnostic(error: unknown): string {
  const message = error instanceof Error
    ? `${error.name}: ${error.message}${error.cause instanceof Error ? `; cause: ${error.cause.name}: ${error.cause.message}` : ''}`
    : String(error)
  return message.replaceAll(/[\r\n\t]+/g, ' ').slice(0, MAX_DIAGNOSTIC_CODE_UNITS)
}

function freeze<T>(value: T): T {
  const clone = structuredClone(value)
  const pending: unknown[] = [clone]
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    if (typeof entry !== 'object' || entry === null) continue
    pending.push(...Object.values(entry as Record<string, unknown>))
    Object.freeze(entry)
  }
  return clone
}

export default LocalMcpConnections
