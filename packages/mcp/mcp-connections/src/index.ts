/**
 * Service Definition for durable, dynamically managed MCP connection desired
 * state. Providers own storage and live MCP clients; consumers use one
 * revisioned API for inventory and lifecycle mutations.
 * @module @deepseek-ai/dsh-mcp-connections
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type {
  ConfigureMcpConnectionRequest,
  McpConnectionChange,
  McpConnectionDesired,
  McpConnectionId,
  McpConnectionMutationId,
  McpConnectionMutationReceipt,
  McpConnectionMutationRequest,
  McpConnectionsSnapshot,
  McpConnectionView,
  McpReconnectPolicy,
  McpStreamableHttpTransportDescriptor,
  McpStdioTransportDescriptor,
  McpTransportDescriptor,
  PurgeMcpConnectionRequest,
  RemovedMcpConnectionView,
  RestoreMcpConnectionRequest,
  UpdateMcpConnectionRequest,
} from './types.ts'

export type {
  ConfigureMcpConnectionRequest,
  McpConnectionChange,
  McpConnectionDesired,
  McpConnectionId,
  McpConnectionMutationId,
  McpConnectionMutationReceipt,
  McpConnectionMutationRequest,
  McpConnectionObserved,
  McpConnectionOperation,
  McpConnectionsSnapshot,
  McpConnectionView,
  McpReconnectPolicy,
  McpStreamableHttpTransportDescriptor,
  McpStdioTransportDescriptor,
  McpToolGeneration,
  McpTransportDescriptor,
  PurgeMcpConnectionRequest,
  RemovedMcpConnectionView,
  RestoreMcpConnectionRequest,
  UpdateMcpConnectionRequest,
} from './types.ts'

const CONNECTION_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const MUTATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const DIGEST_PATTERN = /^[a-f0-9]{64}$/

/**
 * Brand and validate one managed MCP connection id.
 * @param value - candidate id and public MCP tool namespace.
 * @returns the validated branded id.
 */
export function mcpConnectionId(value: string): McpConnectionId {
  if (!CONNECTION_ID_PATTERN.test(value)) {
    throw new TypeError(`MCP connection id ${JSON.stringify(value)} must match ${String(CONNECTION_ID_PATTERN)}`)
  }
  return value as McpConnectionId
}

/**
 * Brand and validate one durable mutation id.
 * @param value - candidate idempotency key.
 * @returns the validated branded mutation id.
 */
export function mcpConnectionMutationId(value: string): McpConnectionMutationId {
  if (!MUTATION_ID_PATTERN.test(value)) {
    throw new TypeError(`MCP connection mutation id ${JSON.stringify(value)} must match ${String(MUTATION_ID_PATTERN)}`)
  }
  return value as McpConnectionMutationId
}

/**
 * Whether a string is a canonical SHA-256 digest used by this capability.
 * @param value - candidate lowercase hexadecimal digest.
 * @returns whether the value is exactly 64 hexadecimal characters.
 */
export function isMcpConnectionDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value)
}

/** A desired record changed after the caller read its revision. */
export class McpConnectionConflictError extends Error {
  /** Stable machine code. */
  readonly code = 'MCP_CONNECTION_CONFLICT'
  /** Revision the caller expected. */
  readonly expected: number
  /** Current record revision, or zero when no active record exists. */
  readonly actual: number

  /** Construct a revision conflict diagnostic. */
  constructor(id: McpConnectionId, expected: number, actual: number) {
    super(`MCP connection "${id}" changed since it was read (expected revision ${String(expected)}, now ${String(actual)})`)
    this.name = 'McpConnectionConflictError'
    this.expected = expected
    this.actual = actual
  }
}

/** A lifecycle mutation addressed a record absent from the selected inventory. */
export class McpConnectionNotFoundError extends Error {
  /** Stable machine code. */
  readonly code = 'MCP_CONNECTION_NOT_FOUND'

  /** Construct an absent-record diagnostic. */
  constructor(id: McpConnectionId, inventory: 'active' | 'removed') {
    super(`MCP connection "${id}" does not exist in the ${inventory} inventory`)
    this.name = 'McpConnectionNotFoundError'
  }
}

/** One idempotency key was reused for a different mutation payload. */
export class McpConnectionIdempotencyError extends Error {
  /** Stable machine code. */
  readonly code = 'MCP_CONNECTION_IDEMPOTENCY_MISMATCH'

  /** Construct an idempotency-key mismatch diagnostic. */
  constructor(mutationId: McpConnectionMutationId) {
    super(`MCP connection mutation id "${mutationId}" was already used for a different request`)
    this.name = 'McpConnectionIdempotencyError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpConnections: McpConnections
  }
}

/**
 * Abstract owner of managed MCP connection desired state. Implementations
 * persist revisions and reconcile enabled records with one live MCP client.
 */
export abstract class McpConnections extends Service {
  private readonly eventContext: Context

  /** Exact runtime API revision paired with class identity by capability probes. */
  abstract readonly protocolVersion: 1

  /** Bind the provider to the `ctx.mcpConnections` service key. */
  constructor(ctx: Context) {
    super(ctx, 'mcpConnections')
    this.eventContext = ctx
  }

  /**
   * Return an immutable inventory snapshot.
   * @returns active and removed records at one global revision.
   */
  abstract snapshot(): McpConnectionsSnapshot

  /**
   * Return one active connection view.
   * @param id - connection to read.
   * @returns its immutable view, or undefined when it is not active.
   */
  abstract get(id: McpConnectionId): McpConnectionView | undefined

  /**
   * Return one restorable removed record.
   * @param id - connection to read from the removed inventory.
   * @returns its immutable removed view, or undefined when absent.
   */
  abstract getRemoved(id: McpConnectionId): RemovedMcpConnectionView | undefined

  /**
   * Persist a new desired record and reconcile its enabled state.
   * @param request - complete desired record, zero expected revision, and idempotency key.
   * @returns the durable mutation receipt after runtime reconciliation settles.
   */
  abstract configure(request: ConfigureMcpConnectionRequest): Promise<McpConnectionMutationReceipt>

  /**
   * Enable one active desired record.
   * @param request - target, expected revision, and idempotency key.
   * @returns the durable mutation receipt after activation settles.
   */
  abstract enable(request: McpConnectionMutationRequest): Promise<McpConnectionMutationReceipt>

  /**
   * Disable one active desired record and wait for live tools to disappear.
   * @param request - target, expected revision, and idempotency key.
   * @returns the durable mutation receipt after teardown reaches quiescence.
   */
  abstract disable(request: McpConnectionMutationRequest): Promise<McpConnectionMutationReceipt>

  /**
   * Replace one active record's resolved transport.
   * @param request - replacement transport, expected revision, and idempotency key.
   * @returns the durable mutation receipt after enabled runtime replacement settles.
   */
  abstract update(request: UpdateMcpConnectionRequest): Promise<McpConnectionMutationReceipt>

  /**
   * Move one active record to the restorable removed inventory.
   * @param request - target, expected revision, and idempotency key.
   * @returns the durable mutation receipt after teardown reaches quiescence.
   */
  abstract remove(request: McpConnectionMutationRequest): Promise<McpConnectionMutationReceipt>

  /**
   * Restore one removed record and reconcile its prior enabled state.
   * @param request - removed target, expected tombstone revision, and idempotency key.
   * @returns the durable mutation receipt after runtime reconciliation settles.
   */
  abstract restore(request: RestoreMcpConnectionRequest): Promise<McpConnectionMutationReceipt>

  /**
   * Permanently delete one already removed desired record.
   * @param request - removed target, expected tombstone revision, and idempotency key.
   * @returns the durable mutation receipt after the tombstone is absent.
   */
  abstract purge(request: PurgeMcpConnectionRequest): Promise<McpConnectionMutationReceipt>

  /** Publish one state-specific notification after its source has committed. */
  protected announce(change: McpConnectionChange): void {
    this.eventContext.emit('mcp-connections/change', change)
  }
}

/**
 * Parse and detach a desired record read from a wire or durable JSON boundary.
 * @param value - untrusted JSON value.
 * @param path - diagnostic path naming the value.
 * @returns a recursively frozen exact desired record.
 */
export function parseMcpConnectionDesired(value: unknown, path = '$'): McpConnectionDesired {
  const object = parseExactMcpJsonObject(value, ['id', 'enabled', 'transport'], path)
  if (typeof object.id !== 'string') throw new TypeError(`${path}.id must be a string`)
  if (typeof object.enabled !== 'boolean') throw new TypeError(`${path}.enabled must be a boolean`)
  return deepFreeze({
    id: mcpConnectionId(object.id),
    enabled: object.enabled,
    transport: parseMcpTransportDescriptor(object.transport, `${path}.transport`),
  })
}

/**
 * Parse and detach a fully resolved MCP transport descriptor.
 * @param value - untrusted JSON value.
 * @param path - diagnostic path naming the value.
 * @returns a recursively frozen exact stdio or Streamable HTTP descriptor.
 */
export function parseMcpTransportDescriptor(value: unknown, path = '$'): McpTransportDescriptor {
  if (!isMcpJsonObject(value)) throw new TypeError(`${path} must be an object`)
  if (value.transport === 'stdio') return parseStdio(value, path)
  if (value.transport === 'streamable-http') return parseHttp(value, path)
  throw new TypeError(`${path}.transport must be "stdio" or "streamable-http"`)
}

function parseStdio(value: Record<string, unknown>, path: string): McpStdioTransportDescriptor {
  const object = parseExactMcpJsonObject(
    value,
    ['transport', 'command', 'args', 'env', 'cwd', 'toolCallTimeoutMs', 'reconnect'],
    path,
  )
  const command = nonEmptyString(object.command, `${path}.command`)
  const cwd = stringValue(object.cwd, `${path}.cwd`)
  rejectNul(command, `${path}.command`)
  rejectNul(cwd, `${path}.cwd`)
  return deepFreeze({
    transport: 'stdio',
    command,
    args: stringArray(object.args, `${path}.args`),
    env: stringRecord(object.env, `${path}.env`),
    cwd,
    toolCallTimeoutMs: timerDelay(object.toolCallTimeoutMs, `${path}.toolCallTimeoutMs`),
    reconnect: parseReconnect(object.reconnect, `${path}.reconnect`),
  })
}

function parseHttp(value: Record<string, unknown>, path: string): McpStreamableHttpTransportDescriptor {
  const object = parseExactMcpJsonObject(
    value,
    ['transport', 'url', 'headers', 'redirect', 'toolCallTimeoutMs', 'reconnect'],
    path,
  )
  const urlText = nonEmptyString(object.url, `${path}.url`)
  let url: URL
  try {
    url = new URL(urlText)
  } catch (cause) {
    throw new TypeError(`${path}.url must be an absolute HTTP or HTTPS URL`, { cause })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`${path}.url must use HTTP or HTTPS`)
  }
  return deepFreeze({
    transport: 'streamable-http',
    url: url.toString(),
    headers: stringRecord(object.headers, `${path}.headers`),
    redirect: redirectPolicy(object.redirect, `${path}.redirect`),
    toolCallTimeoutMs: timerDelay(object.toolCallTimeoutMs, `${path}.toolCallTimeoutMs`),
    reconnect: parseReconnect(object.reconnect, `${path}.reconnect`),
  })
}

function parseReconnect(value: unknown, path: string): McpReconnectPolicy {
  const object = parseExactMcpJsonObject(value, ['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'], path)
  if (typeof object.enabled !== 'boolean') throw new TypeError(`${path}.enabled must be a boolean`)
  const initialDelayMs = timerDelay(object.initialDelayMs, `${path}.initialDelayMs`)
  const maxDelayMs = timerDelay(object.maxDelayMs, `${path}.maxDelayMs`)
  if (initialDelayMs > maxDelayMs) throw new TypeError(`${path}.initialDelayMs must not exceed maxDelayMs`)
  return deepFreeze({
    enabled: object.enabled,
    initialDelayMs,
    maxDelayMs,
    maxAttempts: positiveInteger(object.maxAttempts, `${path}.maxAttempts`),
  })
}

/**
 * Parse one exact JSON object for MCP descriptor and durable-state boundaries.
 * @param value - candidate JSON value.
 * @param keys - complete supported key set.
 * @param path - diagnostic path for rejected input.
 * @returns the exact plain object.
 */
export function parseExactMcpJsonObject(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!isMcpJsonObject(value)) throw new TypeError(`${path} must be an object`)
  const unexpected = Object.keys(value).find(key => !keys.includes(key))
  if (unexpected !== undefined) throw new TypeError(`${path}.${unexpected} is not supported`)
  const missing = keys.find(key => !Object.hasOwn(value, key))
  if (missing !== undefined) throw new TypeError(`${path}.${missing} is required`)
  return value
}

/**
 * Return whether a value is a JSON-compatible plain object.
 * @param value - candidate JSON value.
 * @returns whether the value has an ordinary or null object prototype.
 */
export function isMcpJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null)
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new TypeError(`${path} must be a string`)
  return value
}

function nonEmptyString(value: unknown, path: string): string {
  const text = stringValue(value, path)
  if (text.length === 0 || text.trim() !== text) throw new TypeError(`${path} must be non-blank with no surrounding whitespace`)
  return text
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${path} must be a positive safe integer`)
  return value as number
}

function timerDelay(value: unknown, path: string): number {
  const delay = positiveInteger(value, path)
  if (delay > MAX_TIMER_DELAY_MS) {
    throw new TypeError(`${path} must not exceed ${String(MAX_TIMER_DELAY_MS)}`)
  }
  return delay
}

function redirectPolicy(value: unknown, path: string): 'error' | 'follow' | 'manual' {
  if (value !== 'error' && value !== 'follow' && value !== 'manual') {
    throw new TypeError(`${path} must be "error", "follow", or "manual"`)
  }
  return value
}

function rejectNul(value: string, path: string): void {
  if (value.includes('\0')) throw new TypeError(`${path} must not contain NUL`)
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array of strings`)
  return value.map((entry, index) => {
    const text = stringValue(entry, `${path}[${String(index)}]`)
    rejectNul(text, `${path}[${String(index)}]`)
    return text
  })
}

function stringRecord(value: unknown, path: string): Record<string, string> {
  if (!isMcpJsonObject(value)) throw new TypeError(`${path} must be a string map`)
  const output = Object.create(null) as Record<string, string>
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0) throw new TypeError(`${path} keys must be non-empty`)
    rejectNul(key, `${path} key`)
    const text = stringValue(entry, `${path}.${key}`)
    rejectNul(text, `${path}.${key}`)
    output[key] = text
  }
  return output
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

export default McpConnections
