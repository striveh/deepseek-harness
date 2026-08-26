# 受管 MCP 连接

[English](mcp-connections.md) | 中文

受管 MCP connection seam 为生命周期 client 提供一个带 revision fence 的期望状态 owner，同时复用普通 MCP protocol client。[`dsh-mcp-connections`](../../packages/mcp/mcp-connections) 发布 `ctx.mcpConnections`；[`dsh-mcp-connections-local`](../../packages/mcp/mcp-connections-local) 保存期望记录，并为每个 enabled 记录挂载一个普通 [`dsh-mcp-client`](../../packages/mcp/mcp-client) Fiber。

## 期望状态与证据

每个 descriptor 绑定稳定 connection id、enabled 状态、reconnect 与 timeout policy，以及一个准确的 stdio 或 streamable-HTTP transport。Streamable HTTP 还必须明确指定 Fetch 重定向策略；Extension Center 只准入 `error`，其他 consumer 必须审查跟随重定向或把重定向手动暴露给调用方的决定。读取会分别呈现已提交期望状态、运行时 observation、记录 revision、qualified Tool name 与 Tool generation。调用方必须在每次 mutation 中携带记录 revision 和单个幂等 key；过期 revision 会失败，不会覆盖更新后的 descriptor。

## 生命周期与持久化

Configure 创建 disabled 或 enabled 记录；enable 与 disable 只改变期望 activation；update 替换准确 transport；remove 把记录移入保留的可恢复状态；restore 恢复该 descriptor；purge 只永久删除准确的已移除记录。provider 会等待动态 client reconciliation：disable、replace、remove 或 dispose 记录时撤回对应 Tool，并等待 client Fiber teardown；purge 不改变实时运行时。local store 在 Harness home 下写入 owner-only 的 checksum state、last-good state 与 digest-linked journal。启动时，如果当前 state 损坏，会从 last-good 恢复；它只截断无效 journal suffix，并把 journal head 与权威 state 对齐。

这个 seam 不携带 authentication value。上层产品只传入已经通过 credential-reference owner 解析的 descriptor；P0 Extension Center 仅准入 zero-secret MCP 候选。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
