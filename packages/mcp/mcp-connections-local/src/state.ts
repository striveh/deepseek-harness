/**
 * Strict durable JSON format and canonical digests for the local MCP
 * connection provider.
 * @module @deepseek-ai/dsh-mcp-connections-local/state
 */

import { createHash } from 'node:crypto'
import {
  isMcpConnectionDigest,
  isMcpJsonObject,
  mcpConnectionId,
  mcpConnectionMutationId,
  parseExactMcpJsonObject,
  parseMcpConnectionDesired,
  type McpConnectionDesired,
  type McpConnectionId,
  type McpConnectionMutationId,
  type McpConnectionMutationReceipt,
  type McpConnectionOperation,
} from '@deepseek-ai/dsh-mcp-connections'

/** Current local desired-state file version. */
export const MCP_CONNECTION_STATE_VERSION = 1

/** One active durable desired record. */
export interface StoredMcpConnection {
  /** Complete desired record. */
  desired: McpConnectionDesired
  /** Monotonic record revision. */
  revision: number
}

/** One removed record retained for restore. */
export interface StoredRemovedMcpConnection extends StoredMcpConnection {
  /** Global revision at which removal committed. */
  removedAtRevision: number
}

/** One accepted idempotency key and exact durable receipt. */
export interface StoredMcpMutation {
  /** Durable idempotency key. */
  mutationId: McpConnectionMutationId
  /** Digest of operation name and request fields. */
  requestDigest: string
  /** Exact receipt returned on replay. */
  receipt: McpConnectionMutationReceipt
}

/** Authoritative durable desired-state payload. */
export interface StoredMcpConnectionsState {
  /** File format version. */
  formatVersion: typeof MCP_CONNECTION_STATE_VERSION
  /** Monotonic revision across every accepted mutation. */
  revision: number
  /** Active records sorted by id before serialization. */
  connections: StoredMcpConnection[]
  /** Removed records sorted by id before serialization. */
  removed: StoredRemovedMcpConnection[]
  /** Accepted idempotency entries in commit order. */
  mutations: StoredMcpMutation[]
}

interface StateEnvelope {
  formatVersion: typeof MCP_CONNECTION_STATE_VERSION
  state: StoredMcpConnectionsState
  digest: string
}

interface ReplayedMcpConnection {
  readonly location: 'active' | 'removed'
  readonly revision: number
  readonly desiredDigest: string
  readonly removedAtRevision: number | null
}

/**
 * Create the empty initial desired-state payload.
 * @returns a mutable versioned state with revision zero.
 */
export function emptyStoredState(): StoredMcpConnectionsState {
  return {
    formatVersion: MCP_CONNECTION_STATE_VERSION,
    revision: 0,
    connections: [],
    removed: [],
    mutations: [],
  }
}

/**
 * SHA-256 digest of canonical lossless JSON data.
 * @param value - JSON-compatible value to digest.
 * @returns lowercase hexadecimal SHA-256 digest.
 */
export function digestCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex')
}

/**
 * Digest one complete desired record for receipts.
 * @param desired - exact desired record after the mutation.
 * @returns lowercase hexadecimal SHA-256 digest.
 */
export function digestDesired(desired: McpConnectionDesired): string {
  return digestCanonical(desired)
}

/**
 * Deterministic JSON with recursively sorted object keys.
 * @param value - JSON-compatible value to encode.
 * @returns compact canonical JSON text.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/**
 * Return a detached, validated copy of one stored state.
 * @param state - trusted in-process state to detach through its durable parser.
 * @returns a mutable validated copy.
 */
export function cloneStoredState(state: StoredMcpConnectionsState): StoredMcpConnectionsState {
  return parseStoredState(JSON.parse(JSON.stringify(state)) as unknown)
}

/**
 * Serialize a checksummed state envelope for atomic replacement.
 * @param state - complete authoritative state.
 * @returns newline-terminated JSON envelope.
 */
export function serializeStateEnvelope(state: StoredMcpConnectionsState): string {
  normalizeStoredState(state)
  const envelope: StateEnvelope = {
    formatVersion: MCP_CONNECTION_STATE_VERSION,
    state,
    digest: digestCanonical(state),
  }
  return `${JSON.stringify(envelope, undefined, 2)}\n`
}

/**
 * Parse and verify one checksummed state envelope.
 * @param text - complete JSON file contents.
 * @param path - diagnostic path naming the file.
 * @returns validated authoritative state.
 */
export function parseStateEnvelope(text: string, path: string): StoredMcpConnectionsState {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (cause) {
    throw new Error(`mcp-connections-local: invalid JSON state envelope at ${path}`, { cause })
  }
  const envelope = parseExactMcpJsonObject(raw, ['formatVersion', 'state', 'digest'], path)
  if (envelope.formatVersion !== MCP_CONNECTION_STATE_VERSION) {
    throw new Error(`mcp-connections-local: unsupported state envelope version at ${path}`)
  }
  if (typeof envelope.digest !== 'string' || !isMcpConnectionDigest(envelope.digest)) {
    throw new Error(`mcp-connections-local: invalid state digest at ${path}`)
  }
  if (digestCanonical(envelope.state) !== envelope.digest) {
    throw new Error(`mcp-connections-local: state digest mismatch at ${path}`)
  }
  return parseStoredState(envelope.state)
}

/**
 * Sort records into their canonical durable order.
 * @param state - mutable state whose active and removed arrays are normalized in place.
 */
export function normalizeStoredState(state: StoredMcpConnectionsState): void {
  state.connections.sort((left, right) => compareCodeUnits(left.desired.id, right.desired.id))
  state.removed.sort((left, right) => compareCodeUnits(left.desired.id, right.desired.id))
}

/**
 * Compare strings by ECMAScript code units, independent of host ICU locale.
 * @param left - first string.
 * @param right - second string.
 * @returns negative, positive, or zero according to canonical code-unit order.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function parseStoredState(value: unknown): StoredMcpConnectionsState {
  const object = parseExactMcpJsonObject(
    value,
    ['formatVersion', 'revision', 'connections', 'removed', 'mutations'],
    '$.state',
  )
  if (object.formatVersion !== MCP_CONNECTION_STATE_VERSION) {
    throw new Error('mcp-connections-local: unsupported desired-state version')
  }
  const revision = nonNegativeInteger(object.revision, '$.state.revision')
  const connections = arrayValue(object.connections, '$.state.connections').map((entry, index) => {
    const record = parseExactMcpJsonObject(entry, ['desired', 'revision'], `$.state.connections[${String(index)}]`)
    return {
      desired: parseMcpConnectionDesired(record.desired, `$.state.connections[${String(index)}].desired`),
      revision: positiveInteger(record.revision, `$.state.connections[${String(index)}].revision`),
    }
  })
  const removed = arrayValue(object.removed, '$.state.removed').map((entry, index) => {
    const record = parseExactMcpJsonObject(
      entry,
      ['desired', 'revision', 'removedAtRevision'],
      `$.state.removed[${String(index)}]`,
    )
    return {
      desired: parseMcpConnectionDesired(record.desired, `$.state.removed[${String(index)}].desired`),
      revision: positiveInteger(record.revision, `$.state.removed[${String(index)}].revision`),
      removedAtRevision: positiveInteger(record.removedAtRevision, `$.state.removed[${String(index)}].removedAtRevision`),
    }
  })
  const mutations = arrayValue(object.mutations, '$.state.mutations').map(parseStoredMutation)
  const ids = new Set<McpConnectionId>()
  for (const record of [...connections, ...removed]) {
    if (ids.has(record.desired.id)) throw new Error(`mcp-connections-local: duplicate connection id "${record.desired.id}" in durable state`)
    ids.add(record.desired.id)
    if (record.revision > revision) throw new Error(`mcp-connections-local: connection "${record.desired.id}" revision exceeds the global revision`)
  }
  for (const [records, label] of [
    [connections, 'connections'],
    [removed, 'removed'],
  ] as const) {
    for (let index = 1; index < records.length; index += 1) {
      const previous = records.at(index - 1)
      const current = records.at(index)
      /* v8 ignore next -- loop bounds guarantee both entries. */
      if (previous === undefined || current === undefined) throw new Error('mcp-connections-local: record order scan exceeded its array')
      if (compareCodeUnits(previous.desired.id, current.desired.id) > 0) {
        throw new Error(`mcp-connections-local: durable ${label} records are not sorted by id`)
      }
    }
  }
  for (const record of removed) {
    if (record.removedAtRevision > revision) throw new Error(`mcp-connections-local: removed connection "${record.desired.id}" exceeds the global revision`)
  }
  const mutationIds = new Set<McpConnectionMutationId>()
  for (const [index, mutation] of mutations.entries()) {
    if (mutationIds.has(mutation.mutationId)) throw new Error(`mcp-connections-local: duplicate mutation id "${mutation.mutationId}" in durable state`)
    mutationIds.add(mutation.mutationId)
    const expectedSnapshotRevision = index + 1
    if (mutation.receipt.snapshotRevision !== expectedSnapshotRevision) {
      throw new Error(`mcp-connections-local: mutation "${mutation.mutationId}" snapshot revision is not commit-order contiguous`)
    }
  }
  const finalSnapshotRevision = mutations.at(-1)?.receipt.snapshotRevision ?? 0
  if (finalSnapshotRevision !== revision) {
    throw new Error('mcp-connections-local: final mutation snapshot revision does not match the global revision')
  }
  assertMutationHistoryMatchesInventory(connections, removed, mutations)
  return { formatVersion: MCP_CONNECTION_STATE_VERSION, revision, connections, removed, mutations }
}

function assertMutationHistoryMatchesInventory(
  connections: readonly StoredMcpConnection[],
  removed: readonly StoredRemovedMcpConnection[],
  mutations: readonly StoredMcpMutation[],
): void {
  const replayed = new Map<McpConnectionId, ReplayedMcpConnection>()
  for (const mutation of mutations) {
    const { receipt } = mutation
    const prior = replayed.get(receipt.id)
    if (receipt.operation === 'configure') {
      if (prior !== undefined || receipt.desiredDigest === null) {
        throw new Error(`mcp-connections-local: mutation history cannot configure existing connection "${receipt.id}"`)
      }
      replayed.set(receipt.id, {
        location: 'active',
        revision: receipt.revision,
        desiredDigest: receipt.desiredDigest,
        removedAtRevision: null,
      })
      continue
    }
    if (prior === undefined || receipt.previousRevision !== prior.revision) {
      throw new Error(`mcp-connections-local: mutation history revision for connection "${receipt.id}" is unreachable`)
    }
    if (receipt.operation === 'enable' || receipt.operation === 'disable' || receipt.operation === 'update') {
      if (prior.location !== 'active' || receipt.desiredDigest === null
        || (receipt.changed === (receipt.desiredDigest === prior.desiredDigest))) {
        throw new Error(`mcp-connections-local: mutation history cannot ${receipt.operation} connection "${receipt.id}"`)
      }
      replayed.set(receipt.id, {
        location: 'active',
        revision: receipt.revision,
        desiredDigest: receipt.desiredDigest,
        removedAtRevision: null,
      })
      continue
    }
    if (receipt.operation === 'remove') {
      if (prior.location !== 'active' || receipt.desiredDigest !== prior.desiredDigest) {
        throw new Error(`mcp-connections-local: mutation history cannot remove connection "${receipt.id}"`)
      }
      replayed.set(receipt.id, {
        location: 'removed',
        revision: receipt.revision,
        desiredDigest: prior.desiredDigest,
        removedAtRevision: receipt.snapshotRevision,
      })
      continue
    }
    if (receipt.operation === 'restore') {
      if (prior.location !== 'removed' || receipt.desiredDigest !== prior.desiredDigest) {
        throw new Error(`mcp-connections-local: mutation history cannot restore connection "${receipt.id}"`)
      }
      replayed.set(receipt.id, {
        location: 'active',
        revision: receipt.revision,
        desiredDigest: prior.desiredDigest,
        removedAtRevision: null,
      })
      continue
    }
    if (prior.location !== 'removed' || receipt.desiredDigest !== null) {
      throw new Error(`mcp-connections-local: mutation history cannot purge connection "${receipt.id}"`)
    }
    replayed.delete(receipt.id)
  }

  const inventory = new Map<McpConnectionId, ReplayedMcpConnection>()
  for (const record of connections) {
    inventory.set(record.desired.id, {
      location: 'active',
      revision: record.revision,
      desiredDigest: digestDesired(record.desired),
      removedAtRevision: null,
    })
  }
  for (const record of removed) {
    inventory.set(record.desired.id, {
      location: 'removed',
      revision: record.revision,
      desiredDigest: digestDesired(record.desired),
      removedAtRevision: record.removedAtRevision,
    })
  }
  if (inventory.size !== replayed.size) {
    throw new Error('mcp-connections-local: final inventory does not match mutation history')
  }
  for (const [id, expected] of replayed) {
    const actual = inventory.get(id)
    if (actual === undefined || actual.location !== expected.location || actual.revision !== expected.revision
      || actual.desiredDigest !== expected.desiredDigest
      || actual.removedAtRevision !== expected.removedAtRevision) {
      throw new Error(`mcp-connections-local: final inventory for connection "${id}" does not match mutation history`)
    }
  }
}

function parseStoredMutation(value: unknown, index: number): StoredMcpMutation {
  const path = `$.state.mutations[${String(index)}]`
  const object = parseExactMcpJsonObject(value, ['mutationId', 'requestDigest', 'receipt'], path)
  if (typeof object.mutationId !== 'string') throw new TypeError(`${path}.mutationId must be a string`)
  if (typeof object.requestDigest !== 'string' || !isMcpConnectionDigest(object.requestDigest)) {
    throw new TypeError(`${path}.requestDigest must be a SHA-256 digest`)
  }
  const mutationId = mcpConnectionMutationId(object.mutationId)
  const receipt = parseMcpConnectionMutationReceipt(object.receipt, `${path}.receipt`)
  if (receipt.mutationId !== mutationId) throw new Error(`${path}.receipt mutation id does not match its entry`)
  return { mutationId, requestDigest: object.requestDigest, receipt }
}

/**
 * Parse one exact durable mutation receipt and enforce operation/revision relationships.
 * @param value - untrusted receipt value from state or journal storage.
 * @param path - diagnostic JSON path.
 * @returns validated receipt with branded identifiers.
 */
export function parseMcpConnectionMutationReceipt(
  value: unknown,
  path: string,
): McpConnectionMutationReceipt {
  if (!isMcpJsonObject(value)) throw new TypeError(`${path} must be an object`)
  const optionalPrevious = Object.hasOwn(value, 'previousRevision')
  const object = parseExactMcpJsonObject(
    value,
    optionalPrevious
      ? ['mutationId', 'operation', 'id', 'previousRevision', 'revision', 'snapshotRevision', 'changed', 'desiredDigest']
      : ['mutationId', 'operation', 'id', 'revision', 'snapshotRevision', 'changed', 'desiredDigest'],
    path,
  )
  if (typeof object.mutationId !== 'string') throw new TypeError(`${path}.mutationId must be a string`)
  if (typeof object.id !== 'string') throw new TypeError(`${path}.id must be a string`)
  if (!isOperation(object.operation)) throw new TypeError(`${path}.operation is not supported`)
  if (typeof object.changed !== 'boolean') throw new TypeError(`${path}.changed must be a boolean`)
  if (object.desiredDigest !== null
    && (typeof object.desiredDigest !== 'string' || !isMcpConnectionDigest(object.desiredDigest))) {
    throw new TypeError(`${path}.desiredDigest must be a SHA-256 digest or null`)
  }
  if ((object.operation === 'purge') !== (object.desiredDigest === null)) {
    throw new TypeError(`${path}.desiredDigest must be null exactly for purge`)
  }
  if (object.operation === 'configure' && optionalPrevious) {
    throw new TypeError(`${path}.previousRevision must be absent for configure`)
  }
  if (object.operation !== 'configure' && !optionalPrevious) {
    throw new TypeError(`${path}.previousRevision is required outside configure`)
  }
  const receipt: McpConnectionMutationReceipt = {
    mutationId: mcpConnectionMutationId(object.mutationId),
    operation: object.operation,
    id: mcpConnectionId(object.id),
    revision: positiveInteger(object.revision, `${path}.revision`),
    snapshotRevision: positiveInteger(object.snapshotRevision, `${path}.snapshotRevision`),
    changed: object.changed,
    desiredDigest: object.desiredDigest,
    ...optionalPrevious ? { previousRevision: positiveInteger(object.previousRevision, `${path}.previousRevision`) } : {},
  }
  if (receipt.operation === 'configure') {
    if (!receipt.changed || receipt.revision !== 1) {
      throw new Error(`${path} configure must create changed revision 1`)
    }
    return receipt
  }
  const previousRevision = receipt.previousRevision as number
  const expectedRevision = receipt.changed ? previousRevision + 1 : previousRevision
  if (!Number.isSafeInteger(expectedRevision) || receipt.revision !== expectedRevision) {
    throw new Error(`${path}.revision does not follow previousRevision and changed`)
  }
  if ((receipt.operation === 'remove' || receipt.operation === 'restore' || receipt.operation === 'purge')
    && !receipt.changed) {
    throw new Error(`${path}.${receipt.operation} must report changed`)
  }
  return receipt
}

function isOperation(value: unknown): value is McpConnectionOperation {
  return value === 'configure' || value === 'enable' || value === 'disable'
    || value === 'update' || value === 'remove' || value === 'restore' || value === 'purge'
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isMcpJsonObject(value)) return value
  const output = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key])
  return output
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`)
  return value
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${path} must be a non-negative safe integer`)
  return value as number
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${path} must be a positive safe integer`)
  return value as number
}
