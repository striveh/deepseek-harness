# Managed MCP Connections

English | [中文](mcp-connections.zh.md)

The managed MCP connection seam gives lifecycle clients one revision-fenced desired-state owner without replacing the ordinary MCP protocol client. [`dsh-mcp-connections`](../../packages/mcp/mcp-connections) publishes `ctx.mcpConnections`; [`dsh-mcp-connections-local`](../../packages/mcp/mcp-connections-local) stores desired records and mounts one ordinary [`dsh-mcp-client`](../../packages/mcp/mcp-client) Fiber for each enabled record.

## Desired state and evidence

Each descriptor binds a stable connection id, enabled state, reconnect and timeout policy, and one exact stdio or streamable-HTTP transport. Streamable HTTP also requires an explicit Fetch redirect policy; the Extension Center admits `error`, while other consumers must review any decision to follow or expose redirects manually. Reads keep committed desired state, runtime observation, record revision, qualified Tool names, and Tool generation separate. A caller carries the record revision and a single idempotency key into every mutation; stale revisions fail instead of overwriting a newer descriptor.

## Lifecycle and durability

Configure creates a disabled or enabled record, enable and disable change only desired activation, update replaces the exact transport, remove moves the record into retained restorable state, restore returns that retained descriptor, and purge permanently deletes only an exact removed record. The provider waits for dynamic client reconciliation: disabling, replacing, removing, or disposing a record withdraws its Tools and awaits the client Fiber teardown; purge has no live runtime to change. The local store writes owner-only checksummed state, last-good state, and a digest-linked journal under the Harness home. Startup restores last-good state when current state is corrupt, truncates only an invalid journal suffix, and reconciles its journal head to the authoritative state.

Authentication values are not part of this seam. Higher-level products pass only descriptors already resolved through a credential-reference owner; the P0 Extension Center admits zero-secret MCP candidates.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmcpconnections--mcpconnections-abstract-seam"></a>

### `ctx.mcpConnections` — `McpConnections` (abstract seam)

Abstract owner of managed MCP connection desired state. Implementations persist revisions and reconcile enabled records with one live MCP client.

```ts cordis-catalog
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
```

Source: [`packages/mcp/mcp-connections/src/index.ts`](../../packages/mcp/mcp-connections/src/index.ts)

<a id="mcp-connections-events"></a>

### `mcp-connections/*` events

<a id="mcp-connectionschange--emit"></a>

#### `mcp-connections/change` — emit

Announces committed MCP desired state or a published Host/tool observation. The active view is already queryable through `ctx.mcpConnections` when present; removal is already absent from the active inventory, and purge is absent from both active and removed inventories.

```ts cordis-catalog
/**
 * Announces committed MCP desired state or a published Host/tool observation.
 * The active view is already queryable through `ctx.mcpConnections` when
 * present; removal is already absent from the active inventory, and purge
 * is absent from both active and removed inventories.
 * @param change - committed change and its post-commit active view.
 * @mode emit
 */
'mcp-connections/change'(change: McpConnectionChange): void
```

Source: [`packages/mcp/mcp-connections/src/types.ts`](../../packages/mcp/mcp-connections/src/types.ts)
<!-- END GENERATED cordis-surface -->
