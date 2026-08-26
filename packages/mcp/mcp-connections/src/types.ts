/**
 * Type-only API for managed MCP connection desired state, runtime observation,
 * tool generations, mutations, and receipts.
 * @module @deepseek-ai/dsh-mcp-connections/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable id of one managed MCP connection and its public tool namespace. */
export type McpConnectionId = Branded<'McpConnectionId'>

/** Durable idempotency key of one MCP desired-state mutation. */
export type McpConnectionMutationId = Branded<'McpConnectionMutationId'>

/** Fully resolved reconnect policy passed to the MCP connection supervisor. */
export interface McpReconnectPolicy {
  /** Whether a live connection restarts after transport loss. */
  readonly enabled: boolean
  /** First reconnect delay in milliseconds. */
  readonly initialDelayMs: number
  /** Reconnect delay ceiling and stable-generation window in milliseconds. */
  readonly maxDelayMs: number
  /** Consecutive failed attempts permitted for one outage. */
  readonly maxAttempts: number
}

/** Desired child-process transport for one MCP server. */
export interface McpStdioTransportDescriptor {
  /** Selects the child-process stdio transport. */
  readonly transport: 'stdio'
  /** Executable passed directly to the subprocess provider. */
  readonly command: string
  /** Arguments passed without shell interpolation. */
  readonly args: readonly string[]
  /** Explicit environment additions for the MCP subprocess. */
  readonly env: Readonly<Record<string, string>>
  /** Working directory, or an empty string to inherit the provider default. */
  readonly cwd: string
  /** Per-tool-call timeout in milliseconds. */
  readonly toolCallTimeoutMs: number
  /** Reconnect policy for a successfully activated connection. */
  readonly reconnect: McpReconnectPolicy
}

/** Desired Streamable HTTP transport for one MCP server. */
export interface McpStreamableHttpTransportDescriptor {
  /** Selects MCP Streamable HTTP. */
  readonly transport: 'streamable-http'
  /** Absolute HTTP or HTTPS MCP endpoint. */
  readonly url: string
  /** Headers attached to MCP requests. */
  readonly headers: Readonly<Record<string, string>>
  /** Explicit redirect policy applied by the MCP HTTP transport. */
  readonly redirect: 'error' | 'follow' | 'manual'
  /** Per-tool-call timeout in milliseconds. */
  readonly toolCallTimeoutMs: number
  /** Reconnect policy for a successfully activated connection. */
  readonly reconnect: McpReconnectPolicy
}

/** Fully resolved desired transport accepted by the manager. */
export type McpTransportDescriptor = McpStdioTransportDescriptor | McpStreamableHttpTransportDescriptor

/** Durable desired record for one managed connection. */
export interface McpConnectionDesired {
  /** Stable connection id and MCP public tool namespace. */
  readonly id: McpConnectionId
  /** Whether the Host should keep a live MCP client mounted. */
  readonly enabled: boolean
  /** Fully resolved transport configuration. */
  readonly transport: McpTransportDescriptor
}

/** Host lifecycle observation kept separate from durable desired state. */
export interface McpConnectionObserved {
  /** Current manager-owned lifecycle phase. */
  readonly state: 'disabled' | 'connecting' | 'ready' | 'stopping' | 'error'
  /** Desired-record revision this observation applies to. */
  readonly desiredRevision: number
  /** Monotonic live-runtime generation in this Host process. */
  readonly generation: number
  /** Sanitized startup or teardown diagnostic for an error observation. */
  readonly message?: string
}

/** Actual MCP tool registry generation, independent of desired and runtime revisions. */
export interface McpToolGeneration {
  /** Monotonic generation in this Host process. */
  readonly generation: number
  /** Digest of the complete server-qualified tool schemas in this generation. */
  readonly digest: string
  /** Sorted public tool names currently registered for this connection. */
  readonly names: readonly string[]
}

/** Complete active connection view. */
export interface McpConnectionView {
  /** Stable connection id. */
  readonly id: McpConnectionId
  /** Monotonic durable desired-record revision. */
  readonly revision: number
  /** Durable desired state. */
  readonly desired: McpConnectionDesired
  /** Current Host lifecycle observation. */
  readonly observed: McpConnectionObserved
  /** Current actual tool generation. */
  readonly tools: McpToolGeneration
}

/** Restorable removed record retained outside the active inventory. */
export interface RemovedMcpConnectionView {
  /** Stable connection id. */
  readonly id: McpConnectionId
  /** Monotonic desired-record revision, including removal. */
  readonly revision: number
  /** Desired state restored by {@link McpConnections.restore}. */
  readonly desired: McpConnectionDesired
  /** Global snapshot revision at which removal committed. */
  readonly removedAtRevision: number
}

/** Immutable inventory snapshot at one durable global revision. */
export interface McpConnectionsSnapshot {
  /** Global desired-state revision. */
  readonly revision: number
  /** Active records sorted by id. */
  readonly connections: readonly McpConnectionView[]
  /** Restorable removed records sorted by id. */
  readonly removed: readonly RemovedMcpConnectionView[]
}

/** Common revision and idempotency fields for a mutation of one known record. */
export interface McpConnectionMutationRequest {
  /** Target connection. */
  readonly id: McpConnectionId
  /** Durable idempotency key; reuse is permitted only for the exact same request. */
  readonly mutationId: McpConnectionMutationId
  /** Desired-record revision the caller read. */
  readonly expectedRevision: number
}

/** Create one desired record. */
export interface ConfigureMcpConnectionRequest {
  /** Complete desired record; new connections use revision zero as the expected value. */
  readonly desired: McpConnectionDesired
  /** Durable idempotency key. */
  readonly mutationId: McpConnectionMutationId
  /** Must be zero because no record exists yet. */
  readonly expectedRevision: 0
}

/** Replace the transport of one active desired record. */
export interface UpdateMcpConnectionRequest extends McpConnectionMutationRequest {
  /** Complete resolved replacement transport. */
  readonly transport: McpTransportDescriptor
}

/** Restore one removed desired record. */
export type RestoreMcpConnectionRequest = McpConnectionMutationRequest

/** Permanently delete one already removed desired record. */
export type PurgeMcpConnectionRequest = McpConnectionMutationRequest

/** Desired-state operation recorded in a mutation receipt. */
export type McpConnectionOperation = 'configure' | 'enable' | 'disable' | 'update' | 'remove' | 'restore' | 'purge'

/** Durable receipt for one accepted mutation or its idempotent replay. */
export interface McpConnectionMutationReceipt {
  /** Durable idempotency key. */
  readonly mutationId: McpConnectionMutationId
  /** Applied operation. */
  readonly operation: McpConnectionOperation
  /** Target connection. */
  readonly id: McpConnectionId
  /** Record revision before the mutation, absent only for configure. */
  readonly previousRevision?: number
  /** Record revision after the mutation. */
  readonly revision: number
  /** Global desired-state revision containing this receipt. */
  readonly snapshotRevision: number
  /** Whether the requested desired value differed from the stored value. */
  readonly changed: boolean
  /** Digest of the resulting desired record, including removed records; `null` after purge. */
  readonly desiredDigest: string | null
}

/** Committed desired, observed, or tool-generation notification. */
export interface McpConnectionChange {
  /** Which independently owned state changed. */
  readonly kind: 'desired' | 'removed' | 'purged' | 'observed' | 'tools'
  /** Affected connection. */
  readonly id: McpConnectionId
  /** Active view after the change; absent after removal or purge. */
  readonly view?: McpConnectionView
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Announces committed MCP desired state or a published Host/tool observation.
     * The active view is already queryable through `ctx.mcpConnections` when
     * present; removal is already absent from the active inventory, and purge
     * is absent from both active and removed inventories.
     * @param change - committed change and its post-commit active view.
     * @mode emit
     */
    'mcp-connections/change'(change: McpConnectionChange): void
  }
}
